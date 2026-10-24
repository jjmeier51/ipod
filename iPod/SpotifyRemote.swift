import Foundation
import SpotifyiOS

/// Wraps Spotify's App Remote (the `SpotifyiOS` framework): controls the Spotify
/// app running on this phone and streams its player state. Works for Free and
/// Premium accounts; the Spotify app must be installed.
@MainActor
final class SpotifyRemote: NSObject {
    struct Snapshot: Equatable {
        var track: RemoteTrack?
        var isPaused: Bool
        var positionMs: Int
        var shuffle: Bool
        var repeatMode: String      // off | track | context
        var receivedAt: Date
    }

    enum RemoteError: LocalizedError {
        case notConnected
        case spotifyNotInstalled
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .notConnected: return "Spotify is not connected"
            case .spotifyNotInstalled: return "The Spotify app is not installed"
            case .failed(let m): return m
            }
        }
    }

    private let auth: SpotifyAuth
    private let configuration: SPTConfiguration
    private lazy var appRemote: SPTAppRemote = {
        let remote = SPTAppRemote(configuration: configuration, logLevel: .none)
        remote.delegate = self
        return remote
    }()

    private(set) var isConnected = false
    private(set) var snapshot: Snapshot?
    private var connectContinuations: [CheckedContinuation<Void, Error>] = []
    private var pendingEnqueue: [String] = []

    var onStateChange: ((Snapshot) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    init(config: SpotifyConfig, auth: SpotifyAuth) {
        self.auth = auth
        self.configuration = SPTConfiguration(clientID: config.clientID, redirectURL: config.redirectURL)
        super.init()
    }

    // MARK: Connection

    /// Connects if the Spotify app is already running (foreground or background);
    /// a failed attempt is reported through the delegate and otherwise ignored.
    func connectIfSpotifyIsActive() async {
        guard !isConnected, auth.isSignedIn else { return }
        guard let token = try? await auth.validAccessToken() else { return }
        appRemote.connectionParameters.accessToken = token
        guard !isConnected else { return }
        try? await attemptConnect()
    }

    /// Connects, waking Spotify with `uri` (which it starts playing) when needed.
    func connect(wakingWith uri: String?) async throws {
        if isConnected { return }
        if let token = try? await auth.validAccessToken() {
            appRemote.connectionParameters.accessToken = token
        }
        if appRemote.connectionParameters.accessToken != nil {
            do {
                try await attemptConnect()
                return
            } catch {
                // Spotify is not running (or the token was refused): hand off below.
            }
        }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            connectContinuations.append(cont)
            armConnectTimeout(seconds: 60)
            // Spotify opens, authorises us and comes back through the URL callback.
            appRemote.authorizeAndPlayURI(uri ?? "") { [weak self] success in
                Task { @MainActor in
                    if !success { self?.failConnect(RemoteError.spotifyNotInstalled) }
                }
            }
        }
    }

    private func attemptConnect() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            connectContinuations.append(cont)
            armConnectTimeout(seconds: 10)
            appRemote.connect()
        }
    }

    private var connectTimeout: Task<Void, Never>?
    private func armConnectTimeout(seconds: Double) {
        connectTimeout?.cancel()
        connectTimeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.failConnect(RemoteError.failed("Timed out connecting to Spotify"))
        }
    }

    func disconnect() {
        if appRemote.isConnected { appRemote.disconnect() }
    }

    /// Spotify → app callback after `authorizeAndPlayURI`.
    func handle(callbackURL url: URL) -> Bool {
        guard let params = appRemote.authorizationParameters(from: url) else { return false }
        if let token = params[SPTAppRemoteAccessTokenKey] {
            appRemote.connectionParameters.accessToken = token
            appRemote.connect()
            return true
        }
        if let message = params[SPTAppRemoteErrorDescriptionKey] {
            failConnect(RemoteError.failed(message))
            return true
        }
        return false
    }

    private func failConnect(_ error: Error) {
        connectTimeout?.cancel()
        connectTimeout = nil
        let conts = connectContinuations
        connectContinuations.removeAll()
        conts.forEach { $0.resume(throwing: error) }
    }

    private func succeedConnect() {
        connectTimeout?.cancel()
        connectTimeout = nil
        let conts = connectContinuations
        connectContinuations.removeAll()
        conts.forEach { $0.resume() }
    }

    // MARK: Player controls

    private var player: SPTAppRemotePlayerAPI {
        get throws {
            guard isConnected, let p = appRemote.playerAPI else { throw RemoteError.notConnected }
            return p
        }
    }

    private func call(_ body: (SPTAppRemotePlayerAPI, @escaping SPTAppRemoteCallback) -> Void) async throws {
        let p = try player
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            body(p) { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    func play(uri: String) async throws { try await call { $0.play(uri, callback: $1) } }
    func enqueue(uri: String) async throws { try await call { $0.enqueueTrackUri(uri, callback: $1) } }
    func resume() async throws { try await call { $0.resume($1) } }
    func pause() async throws { try await call { $0.pause($1) } }
    func skipNext() async throws { try await call { $0.skip(toNext: $1) } }
    func skipPrevious() async throws { try await call { $0.skip(toPrevious: $1) } }
    func seek(toMs ms: Int) async throws { try await call { $0.seek(toPosition: ms, callback: $1) } }
    func setShuffle(_ on: Bool) async throws { try await call { $0.setShuffle(on, callback: $1) } }
    func setRepeat(_ mode: String) async throws {
        let m: SPTAppRemotePlaybackOptionsRepeatMode = mode == "track" ? .track : mode == "context" ? .context : .off
        try await call { $0.setRepeatMode(m, callback: $1) }
    }

    /// Tracks to add to the queue once connected (used after a wake-up play).
    func enqueueWhenConnected(_ uris: [String]) {
        pendingEnqueue = uris
        if isConnected { flushEnqueue() }
    }

    private func flushEnqueue() {
        let uris = pendingEnqueue
        pendingEnqueue = []
        guard !uris.isEmpty else { return }
        Task {
            for uri in uris {
                try? await enqueue(uri: uri)
            }
        }
    }

    func refreshState() {
        guard isConnected else { return }
        appRemote.playerAPI?.getPlayerState { [weak self] result, _ in
            guard let self, let state = result as? SPTAppRemotePlayerState else { return }
            Task { @MainActor in self.ingest(state) }
        }
    }

    private func ingest(_ state: SPTAppRemotePlayerState) {
        let t = state.track
        let repeatMode: String
        switch state.playbackOptions.repeatMode {
        case .track: repeatMode = "track"
        case .context: repeatMode = "context"
        default: repeatMode = "off"
        }
        let snap = Snapshot(
            track: RemoteTrack(uri: t.uri, name: t.name, artist: t.artist.name, album: t.album.name, durationMs: Int(t.duration)),
            isPaused: state.isPaused,
            positionMs: state.playbackPosition,
            shuffle: state.playbackOptions.isShuffling,
            repeatMode: repeatMode,
            receivedAt: Date()
        )
        snapshot = snap
        onStateChange?(snap)
    }
}

extension SpotifyRemote: SPTAppRemoteDelegate, SPTAppRemotePlayerStateDelegate {
    nonisolated func appRemoteDidEstablishConnection(_ appRemote: SPTAppRemote) {
        Task { @MainActor in
            self.isConnected = true
            appRemote.playerAPI?.delegate = self
            appRemote.playerAPI?.subscribe(toPlayerState: { _, _ in })
            self.succeedConnect()
            self.flushEnqueue()
            self.refreshState()
            self.onConnectionChange?(true)
        }
    }

    nonisolated func appRemote(_ appRemote: SPTAppRemote, didFailConnectionAttemptWithError error: Error?) {
        Task { @MainActor in
            self.isConnected = false
            self.failConnect(error ?? RemoteError.notConnected)
            self.onConnectionChange?(false)
        }
    }

    nonisolated func appRemote(_ appRemote: SPTAppRemote, didDisconnectWithError error: Error?) {
        Task { @MainActor in
            self.isConnected = false
            self.failConnect(error ?? RemoteError.notConnected)
            self.onConnectionChange?(false)
        }
    }

    nonisolated func playerStateDidChange(_ playerState: SPTAppRemotePlayerState) {
        Task { @MainActor in self.ingest(playerState) }
    }
}
