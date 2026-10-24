import Foundation
import Combine

/// Owns every native service the iPod UI talks to, and routes bridge calls to them.
@MainActor
final class Services: ObservableObject {
    static let shared = Services()

    let auth: SpotifyAuth
    let api: SpotifyWebAPI
    let library: LibraryStore
    let remote: SpotifyRemote
    let playback: PlaybackController
    let system: SystemServices
    let bridge: WebBridge

    private init() {
        let auth = SpotifyAuth(config: SpotifyConfig.shared)
        let api = SpotifyWebAPI(auth: auth)
        let library = LibraryStore(api: api)
        let remote = SpotifyRemote(config: SpotifyConfig.shared, auth: auth)
        let system = SystemServices()
        let bridge = WebBridge()
        let playback = PlaybackController(remote: remote, api: api, auth: auth, bridge: bridge)
        self.auth = auth
        self.api = api
        self.library = library
        self.remote = remote
        self.system = system
        self.bridge = bridge
        self.playback = playback

        system.onVolumeChange = { [weak bridge] volume in
            bridge?.emit("volume", VolumePayload(volume: volume))
        }
        Task { [weak bridge] in
            await library.setOnUpdate { lib in
                Task { @MainActor in bridge?.emit("library", lib) }
            }
        }
        auth.onChange = { [weak self] in
            guard let self else { return }
            Task { await self.emitAuth() }
        }
        bridge.router = { [weak self] method, args in
            guard let self else { throw BridgeError.unavailable }
            return try await self.route(method: method, args: args)
        }
    }

    func handle(url: URL) {
        // Spotify app → us (App Remote authorisation) or the PKCE session's callback.
        if remote.handle(callbackURL: url) { return }
        auth.handle(callbackURL: url)
    }

    // MARK: - Bridge routing

    private func route(method: String, args: Data) async throws -> Encodable {
        switch method {
        case "auth.status":
            return await authStatus()
        case "auth.signIn":
            try await auth.signIn()
            await playback.authDidChange()
            return await authStatus()
        case "auth.signOut":
            auth.signOut()
            await library.clear()
            await playback.authDidChange()
            return await authStatus()

        case "library.load":
            return try await library.load(forceRefresh: false)
        case "library.refresh":
            return try await library.load(forceRefresh: true)
        case "library.playlistTracks":
            let a = try decode(IDArgs.self, args)
            return TracksPayload(tracks: try await library.playlistTracks(id: a.id))
        case "library.artistTracks":
            let a = try decode(IDArgs.self, args)
            return TracksPayload(tracks: try await library.artistTracks(id: a.id))
        case "library.albumTracks":
            let a = try decode(IDArgs.self, args)
            return TracksPayload(tracks: try await library.albumTracks(id: a.id))

        case "player.play":
            let a = try decode(PlayArgs.self, args)
            try await playback.play(uris: a.uris, offset: a.offset ?? 0, contextUri: a.contextUri)
            return EmptyPayload()
        case "player.resume":
            try await playback.resume()
            return EmptyPayload()
        case "player.pause":
            try await playback.pause()
            return EmptyPayload()
        case "player.next":
            try await playback.next()
            return EmptyPayload()
        case "player.previous":
            try await playback.previous()
            return EmptyPayload()
        case "player.seek":
            let a = try decode(SeekArgs.self, args)
            try await playback.seek(toMs: a.positionMs)
            return EmptyPayload()
        case "player.setShuffle":
            let a = try decode(ShuffleArgs.self, args)
            try await playback.setShuffle(a.enabled)
            return EmptyPayload()
        case "player.setRepeat":
            let a = try decode(RepeatArgs.self, args)
            try await playback.setRepeat(a.mode)
            return EmptyPayload()
        case "player.state":
            return playback.snapshot

        case "system.volume":
            return VolumePayload(volume: system.volume)
        case "system.setVolume":
            let a = try decode(VolumeArgs.self, args)
            system.setVolume(a.volume)
            return VolumePayload(volume: a.volume)
        case "system.haptic":
            let a = (try? decode(HapticArgs.self, args)) ?? HapticArgs(kind: "light")
            system.haptic(kind: a.kind)
            return EmptyPayload()
        case "system.click":
            system.click()
            return EmptyPayload()
        case "system.openSpotify":
            system.openSpotify()
            return EmptyPayload()
        case "system.ready":
            playback.webReady()
            return EmptyPayload()
        default:
            throw BridgeError.unknownMethod(method)
        }
    }

    private func authStatus() async -> AuthStatus {
        guard auth.isSignedIn else {
            return AuthStatus(signedIn: false, displayName: nil, product: nil, spotifyInstalled: system.isSpotifyInstalled)
        }
        let profile = await playback.profile()
        return AuthStatus(signedIn: true, displayName: profile?.displayName, product: profile?.product, spotifyInstalled: system.isSpotifyInstalled)
    }

    private func emitAuth() async {
        bridge.emit("auth", await authStatus())
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }
}

// MARK: - Bridge payloads

struct EmptyPayload: Encodable {}
struct IDArgs: Decodable { let id: String }
struct PlayArgs: Decodable { let uris: [String]; let offset: Int?; let contextUri: String? }
struct SeekArgs: Decodable { let positionMs: Int }
struct ShuffleArgs: Decodable { let enabled: Bool }
struct RepeatArgs: Decodable { let mode: String }
struct VolumeArgs: Decodable { let volume: Double }
struct HapticArgs: Decodable { let kind: String }
struct VolumePayload: Encodable { let volume: Double }
struct TracksPayload: Encodable { let tracks: [Track] }
struct AuthStatus: Encodable {
    let signedIn: Bool
    let displayName: String?
    let product: String?
    let spotifyInstalled: Bool
}

enum BridgeError: LocalizedError {
    case unavailable
    case unknownMethod(String)
    case badArguments

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Service unavailable"
        case .unknownMethod(let m): return "Unknown bridge method \(m)"
        case .badArguments: return "Bad arguments"
        }
    }
}
