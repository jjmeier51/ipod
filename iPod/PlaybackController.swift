import Foundation
import UIKit

/// One playback surface for the iPod UI, backed by two Spotify channels:
/// App Remote (the Spotify app on this phone; works for Free and Premium) and the
/// Web API's Spotify Connect endpoints (Premium; used for "play this list from
/// track N" and as a fallback when App Remote is not connected).
@MainActor
final class PlaybackController {
    struct PlayerStatePayload: Encodable {
        var hasTrack: Bool
        var isPaused: Bool
        var positionMs: Int
        var durationMs: Int
        var track: RemoteTrack?
        var shuffle: Bool
        var `repeat`: String
        var remoteConnected: Bool
    }

    private let remote: SpotifyRemote
    private let api: SpotifyWebAPI
    private let auth: SpotifyAuth
    private weak var bridge: WebBridge?

    private var cachedProfile: UserProfile?
    private var pollTask: Task<Void, Never>?
    private var webState: WebPlayerState?
    private var webStateAt = Date.distantPast
    private var isActive = false
    private var isWebReady = false

    private(set) var snapshot = PlayerStatePayload(hasTrack: false, isPaused: true, positionMs: 0, durationMs: 0, track: nil, shuffle: false, repeat: "off", remoteConnected: false)

    init(remote: SpotifyRemote, api: SpotifyWebAPI, auth: SpotifyAuth, bridge: WebBridge) {
        self.remote = remote
        self.api = api
        self.auth = auth
        self.bridge = bridge
        remote.onStateChange = { [weak self] snap in
            guard let self else { return }
            self.snapshot = PlayerStatePayload(
                hasTrack: snap.track != nil, isPaused: snap.isPaused, positionMs: snap.positionMs,
                durationMs: snap.track?.durationMs ?? 0, track: snap.track, shuffle: snap.shuffle,
                repeat: snap.repeatMode, remoteConnected: true
            )
            self.publish()
        }
        remote.onConnectionChange = { [weak self] connected in
            guard let self else { return }
            self.snapshot.remoteConnected = connected
            if connected { self.stopPolling() } else { self.startPollingIfNeeded() }
            self.publish()
        }
    }

    // MARK: Lifecycle

    func webReady() {
        isWebReady = true
        publish()
    }

    func appDidBecomeActive() {
        isActive = true
        guard auth.isSignedIn else { return }
        Task {
            await remote.connectIfSpotifyIsActive()
            if !remote.isConnected { startPollingIfNeeded() }
        }
    }

    func appDidEnterBackground() {
        isActive = false
        stopPolling()
        remote.disconnect()
    }

    func authDidChange() async {
        cachedProfile = nil
        if auth.isSignedIn {
            await remote.connectIfSpotifyIsActive()
            startPollingIfNeeded()
        } else {
            remote.disconnect()
            stopPolling()
            snapshot = PlayerStatePayload(hasTrack: false, isPaused: true, positionMs: 0, durationMs: 0, track: nil, shuffle: false, repeat: "off", remoteConnected: false)
            publish()
        }
    }

    func profile() async -> UserProfile? {
        if let cachedProfile { return cachedProfile }
        cachedProfile = try? await api.me()
        return cachedProfile
    }

    private var isPremium: Bool {
        get async { (await profile()?.product) == "premium" }
    }

    private func publish() {
        guard isWebReady else { return }
        bridge?.emit("playerState", snapshot)
    }

    // MARK: Polling the Web API while App Remote is not connected

    private func startPollingIfNeeded() {
        guard pollTask == nil, isActive, auth.isSignedIn, !remote.isConnected else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollOnce()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollOnce() async {
        guard !remote.isConnected else { return }
        guard let state = try? await api.playerState() else { return }
        webState = state
        webStateAt = Date()
        snapshot = PlayerStatePayload(
            hasTrack: state.track != nil, isPaused: !state.isPlaying, positionMs: state.progressMs,
            durationMs: state.track?.durationMs ?? 0, track: state.track, shuffle: state.shuffle,
            repeat: state.repeatMode, remoteConnected: false
        )
        publish()
    }

    // MARK: Controls

    /// Plays `uris` starting at `offset`. With a context (playlist/album) and Premium
    /// the whole context plays from that track via Spotify Connect; otherwise the
    /// Spotify app plays the track and the following ones are queued behind it.
    func play(uris: [String], offset: Int, contextUri: String?) async throws {
        guard !uris.isEmpty else { return }
        let index = min(max(offset, 0), uris.count - 1)
        let startURI = uris[index]
        let following = Array(uris.dropFirst(index + 1).prefix(20))

        if await isPremium {
            do {
                try await playViaConnect(uris: uris, index: index, contextUri: contextUri)
                // Spotify is active now; attach App Remote for live state.
                Task { await remote.connectIfSpotifyIsActive() }
                await pollOnce()
                return
            } catch {
                // Fall through to App Remote (no active device, etc.)
            }
        }

        if remote.isConnected {
            try await remote.play(uri: startURI)
            remote.enqueueWhenConnected(following)
        } else {
            remote.enqueueWhenConnected(following)
            try await remote.connect(wakingWith: startURI)
        }
    }

    private func playViaConnect(uris: [String], index: Int, contextUri: String?) async throws {
        var body = SpotifyWebAPI.PlayBody()
        if let contextUri {
            body.context_uri = contextUri
            body.offset = .init(position: nil, uri: uris[index])
        } else {
            body.uris = Array(uris.dropFirst(index).prefix(100))
            body.offset = .init(position: 0, uri: nil)
        }
        if remote.isConnected {
            try await api.play(body, deviceID: nil)
            return
        }
        let devices = try await api.devices()
        let thisPhone = devices.first { $0.type.lowercased() == "smartphone" && $0.name == UIDevice.current.name }
        let device = thisPhone ?? devices.first { $0.is_active } ?? devices.first { $0.type.lowercased() == "smartphone" }
        guard let device, let id = device.id else { throw SpotifyWebAPI.APIError.noActiveDevice }
        try await api.play(body, deviceID: id)
    }

    func resume() async throws {
        if remote.isConnected { try await remote.resume(); return }
        if await isPremium { try await api.resume(); await pollOnce(); return }
        try await remote.connect(wakingWith: snapshot.track?.uri)
    }

    func pause() async throws {
        if remote.isConnected { try await remote.pause(); return }
        if await isPremium { try await api.pause(); await pollOnce(); return }
        throw SpotifyRemote.RemoteError.notConnected
    }

    func next() async throws {
        if remote.isConnected { try await remote.skipNext(); return }
        if await isPremium { try await api.next(); await pollOnce(); return }
        throw SpotifyRemote.RemoteError.notConnected
    }

    func previous() async throws {
        if remote.isConnected { try await remote.skipPrevious(); return }
        if await isPremium { try await api.previous(); await pollOnce(); return }
        throw SpotifyRemote.RemoteError.notConnected
    }

    func seek(toMs ms: Int) async throws {
        if remote.isConnected { try await remote.seek(toMs: ms); return }
        if await isPremium { try await api.seek(ms: ms); await pollOnce(); return }
        throw SpotifyRemote.RemoteError.notConnected
    }

    func setShuffle(_ on: Bool) async throws {
        if remote.isConnected { try await remote.setShuffle(on); return }
        if await isPremium { try? await api.setShuffle(on) }
    }

    func setRepeat(_ mode: String) async throws {
        if remote.isConnected { try await remote.setRepeat(mode); return }
        if await isPremium { try? await api.setRepeat(mode) }
    }
}
