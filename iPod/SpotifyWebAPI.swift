import Foundation
import os

// MARK: - Models shared with the web UI (field names match the JS side)

struct Track: Codable, Hashable {
    let id: String
    let uri: String
    let name: String
    let artistName: String
    let artistIds: [String]
    let albumName: String
    let albumId: String?
    let durationMs: Int
}

struct Playlist: Codable, Hashable {
    let id: String
    let uri: String
    let name: String
    let trackCount: Int
    var snapshotID: String?
}

struct Artist: Codable, Hashable {
    let id: String
    let uri: String
    let name: String
}

struct Album: Codable, Hashable {
    let id: String
    let uri: String
    let name: String
    let artistName: String
}

struct UserProfile: Codable {
    let id: String
    let displayName: String?
    let product: String?
}

struct PlayerDevice: Decodable {
    let id: String?
    let is_active: Bool
    let name: String
    let type: String
}

/// Playback state as read from `GET /me/player` (used when App Remote is not connected).
struct WebPlayerState {
    let isPlaying: Bool
    let progressMs: Int
    let track: RemoteTrack?
    let shuffle: Bool
    let repeatMode: String   // off | track | context
}

struct RemoteTrack: Codable, Equatable {
    let uri: String
    let name: String
    let artist: String
    let album: String
    let durationMs: Int
}

// MARK: - Client

/// Thin async client for the parts of the Spotify Web API the iPod uses.
final class SpotifyWebAPI {
    enum APIError: LocalizedError {
        case http(Int, String)
        case noActiveDevice
        case premiumRequired

        var errorDescription: String? {
            switch self {
            case .http(let code, let body): return "Spotify API error \(code): \(body)"
            case .noActiveDevice: return "No active Spotify device"
            case .premiumRequired: return "Spotify Premium is required for this control"
            }
        }
    }

    private let auth: SpotifyAuth
    private let session = URLSession(configuration: .default)
    private let base = URL(string: "https://api.spotify.com/v1/")!
    private let decoder = JSONDecoder()
    private let log = Logger(subsystem: "ipod", category: "spotify-api")
    private let throttle = RequestThrottle(minimumGap: 0.08)

    init(auth: SpotifyAuth) {
        self.auth = auth
    }

    // MARK: Requests

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Encodable? = nil) async throws -> (Data, HTTPURLResponse) {
        let token = try await auth.validAccessToken()
        var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        var attempt = 0
        while true {
            await throttle.wait()
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw APIError.http(0, "no response") }
            // Spotify rate-limits in bursts; honour Retry-After (it can be tens of seconds).
            if http.statusCode == 429, attempt < 6 {
                let retry = Double(http.value(forHTTPHeaderField: "Retry-After") ?? "2") ?? 2
                let delay = min(max(retry, 1), 90)
                log.notice("429 on \(path, privacy: .public); waiting \(delay)s")
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                attempt += 1
                continue
            }
            if (500..<600).contains(http.statusCode), attempt < 2 {
                try await Task.sleep(nanoseconds: 1_500_000_000)
                attempt += 1
                continue
            }
            guard (200..<300).contains(http.statusCode) else {
                let text = String(decoding: data, as: UTF8.self)
                log.error("\(method, privacy: .public) \(path, privacy: .public) → \(http.statusCode) \(String(text.prefix(300)), privacy: .public)")
                if http.statusCode == 404, text.contains("NO_ACTIVE_DEVICE") { throw APIError.noActiveDevice }
                if http.statusCode == 403, text.contains("PREMIUM_REQUIRED") { throw APIError.premiumRequired }
                throw APIError.http(http.statusCode, text)
            }
            return (data, http)
        }
    }

    private func get<T: Decodable>(_ type: T.Type, _ path: String, query: [URLQueryItem] = []) async throws -> T {
        let (data, _) = try await request("GET", path, query: query)
        do {
            return try decoder.decode(type, from: data)
        } catch {
            log.error("decode \(path, privacy: .public): \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    private struct Page<I: Decodable>: Decodable { let items: [I?]; let next: String? }

    /// Walks a paged endpoint (`items`, `next`) until exhausted or `max` items.
    private func paged<Item: Decodable>(_ type: Item.Type, _ path: String, query: [URLQueryItem], max: Int = 10_000) async throws -> [Item] {
        var results: [Item] = []
        var offset = 0
        let limit = 50
        while results.count < max {
            var q = query
            q.append(.init(name: "limit", value: String(limit)))
            q.append(.init(name: "offset", value: String(offset)))
            let page: Page<Item> = try await get(Page<Item>.self, path, query: q)
            results.append(contentsOf: page.items.compactMap { $0 })
            if page.next == nil || page.items.isEmpty { break }
            offset += limit
        }
        return results
    }

    // MARK: Profile

    func me() async throws -> UserProfile {
        struct Me: Decodable { let id: String; let display_name: String?; let product: String? }
        let m = try await get(Me.self, "me")
        return UserProfile(id: m.id, displayName: m.display_name, product: m.product)
    }

    // MARK: Library

    private struct APIArtistRef: Decodable { let id: String?; let name: String; let uri: String? }
    private struct APIAlbumRef: Decodable { let id: String?; let name: String; let uri: String?; let artists: [APIArtistRef]? }
    private struct APITrack: Decodable {
        let id: String?
        let uri: String?
        let name: String?
        let duration_ms: Int?
        let artists: [APIArtistRef]?
        let album: APIAlbumRef?
        let is_local: Bool?
    }

    private func track(from t: APITrack, album: APIAlbumRef? = nil) -> Track? {
        guard let id = t.id, let uri = t.uri, let name = t.name, t.is_local != true else { return nil }
        let artists = t.artists ?? album?.artists ?? []
        let alb = t.album ?? album
        return Track(
            id: id, uri: uri, name: name,
            artistName: artists.map(\.name).joined(separator: ", "),
            artistIds: artists.compactMap(\.id),
            albumName: alb?.name ?? "",
            albumId: alb?.id,
            durationMs: t.duration_ms ?? 0
        )
    }

    func savedTracks() async throws -> [Track] {
        struct Item: Decodable { let track: APITrack? }
        let items = try await paged(Item.self, "me/tracks", query: [.init(name: "market", value: "from_token")])
        return items.compactMap { $0.track }.compactMap { track(from: $0) }
    }

    func playlists() async throws -> [Playlist] {
        struct Item: Decodable { let id: String; let uri: String; let name: String; let tracks: Count?; let snapshot_id: String?; struct Count: Decodable { let total: Int } }
        let items = try await paged(Item.self, "me/playlists", query: [])
        return items.map { Playlist(id: $0.id, uri: $0.uri, name: $0.name, trackCount: $0.tracks?.total ?? 0, snapshotID: $0.snapshot_id) }
    }

    func playlistTracks(id: String) async throws -> [Track] {
        struct Item: Decodable { let track: APITrack? }
        let fields = "next,total,items(track(id,uri,name,duration_ms,is_local,type,artists(id,name),album(id,name)))"
        let items = try await paged(Item.self, "playlists/\(id)/tracks", query: [.init(name: "fields", value: fields), .init(name: "market", value: "from_token"), .init(name: "additional_types", value: "track")])
        return items.compactMap { $0.track }.compactMap { track(from: $0) }
    }

    func followedArtists() async throws -> [Artist] {
        // Cursor-paged rather than offset-paged.
        struct Resp: Decodable { let artists: Page; struct Page: Decodable { let items: [APIArtistRef]; let cursors: Cursors?; struct Cursors: Decodable { let after: String? } } }
        var results: [Artist] = []
        var after: String?
        repeat {
            var q: [URLQueryItem] = [.init(name: "type", value: "artist"), .init(name: "limit", value: "50")]
            if let after { q.append(.init(name: "after", value: after)) }
            let r = try await get(Resp.self, "me/following", query: q)
            results.append(contentsOf: r.artists.items.compactMap { a in
                guard let id = a.id else { return nil }
                return Artist(id: id, uri: a.uri ?? "spotify:artist:\(id)", name: a.name)
            })
            after = r.artists.cursors?.after
            if r.artists.items.isEmpty { break }
        } while after != nil
        return results
    }

    func savedAlbums() async throws -> [Album] {
        struct Item: Decodable { let album: APIAlbumRef? }
        let items = try await paged(Item.self, "me/albums", query: [.init(name: "market", value: "from_token")])
        return items.compactMap { item in
            guard let a = item.album, let id = a.id else { return nil }
            return Album(id: id, uri: a.uri ?? "spotify:album:\(id)", name: a.name, artistName: (a.artists ?? []).map(\.name).joined(separator: ", "))
        }
    }

    func albumTracks(album: Album) async throws -> [Track] {
        let albumRef = APIAlbumRef(id: album.id, name: album.name, uri: album.uri, artists: nil)
        let items = try await paged(APITrack.self, "albums/\(album.id)/tracks", query: [.init(name: "market", value: "from_token")])
        return items.compactMap { track(from: $0, album: albumRef) }
    }

    func artistTopTracks(id: String) async throws -> [Track] {
        struct Resp: Decodable { let tracks: [APITrack] }
        let r = try await get(Resp.self, "artists/\(id)/top-tracks", query: [.init(name: "market", value: "from_token")])
        return r.tracks.compactMap { track(from: $0) }
    }

    // MARK: Player (Spotify Connect; Premium only for the write calls)

    func devices() async throws -> [PlayerDevice] {
        struct Resp: Decodable { let devices: [PlayerDevice] }
        return try await get(Resp.self, "me/player/devices").devices
    }

    func playerState() async throws -> WebPlayerState? {
        struct Item: Decodable { let uri: String; let name: String; let duration_ms: Int; let artists: [APIArtistRef]?; let album: APIAlbumRef? }
        struct Resp: Decodable { let is_playing: Bool; let progress_ms: Int?; let item: Item?; let shuffle_state: Bool?; let repeat_state: String? }
        let (data, http) = try await request("GET", "me/player", query: [.init(name: "additional_types", value: "track")])
        if http.statusCode == 204 || data.isEmpty { return nil }
        let r = try decoder.decode(Resp.self, from: data)
        let track = r.item.map { RemoteTrack(uri: $0.uri, name: $0.name, artist: ($0.artists ?? []).map(\.name).joined(separator: ", "), album: $0.album?.name ?? "", durationMs: $0.duration_ms) }
        return WebPlayerState(isPlaying: r.is_playing, progressMs: r.progress_ms ?? 0, track: track, shuffle: r.shuffle_state ?? false, repeatMode: r.repeat_state ?? "off")
    }

    struct PlayBody: Encodable {
        var context_uri: String?
        var uris: [String]?
        var offset: Offset?
        var position_ms: Int?
        struct Offset: Encodable { var position: Int?; var uri: String? }
    }

    func play(_ body: PlayBody, deviceID: String?) async throws {
        var q: [URLQueryItem] = []
        if let deviceID { q.append(.init(name: "device_id", value: deviceID)) }
        _ = try await request("PUT", "me/player/play", query: q, body: body)
    }

    func resume() async throws { _ = try await request("PUT", "me/player/play") }
    func pause() async throws { _ = try await request("PUT", "me/player/pause") }
    func next() async throws { _ = try await request("POST", "me/player/next") }
    func previous() async throws { _ = try await request("POST", "me/player/previous") }
    func seek(ms: Int) async throws { _ = try await request("PUT", "me/player/seek", query: [.init(name: "position_ms", value: String(max(0, ms)))]) }
    func setShuffle(_ on: Bool) async throws { _ = try await request("PUT", "me/player/shuffle", query: [.init(name: "state", value: on ? "true" : "false")]) }
    func setRepeat(_ mode: String) async throws { _ = try await request("PUT", "me/player/repeat", query: [.init(name: "state", value: mode)]) }
}

/// Spaces requests out a little so a library crawl doesn't trip Spotify's burst limit.
actor RequestThrottle {
    private let minimumGap: TimeInterval
    private var last = Date.distantPast

    init(minimumGap: TimeInterval) {
        self.minimumGap = minimumGap
    }

    func wait() async {
        let since = Date().timeIntervalSince(last)
        if since < minimumGap {
            try? await Task.sleep(nanoseconds: UInt64((minimumGap - since) * 1_000_000_000))
        }
        last = Date()
    }
}
