import Foundation
import os

/// What the iPod UI receives: the four lists it browses.
struct LibraryPayload: Encodable {
    let playlists: [Playlist]
    let artists: [Artist]
    let albums: [Album]
    let songs: [Track]
}

/// The user's Spotify library shaped like an iPod library.
///
/// Songs are every track the user has: Liked Songs plus the contents of all their
/// playlists, de-duplicated. Artists and Albums are derived from those songs (plus
/// followed artists and saved albums). "Liked Songs" is listed as the first
/// playlist. Everything is cached on disk so the iPod boots instantly next time;
/// the crawl of playlist contents runs in the background and streams updates.
actor LibraryStore {
    static let likedPlaylistID = "liked"

    private let api: SpotifyWebAPI
    private let log = Logger(subsystem: "ipod", category: "library")

    private var library: Library?
    private var transientTracks: [String: [Track]] = [:]   // album/artist screens
    private var quickTask: Task<Library, Error>?
    private var crawlTask: Task<Void, Never>?
    private var onUpdate: ((LibraryPayload) -> Void)?

    private let cacheURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("library-v2.json")
    }()
    private static let staleAfter: TimeInterval = 60 * 30

    init(api: SpotifyWebAPI) {
        self.api = api
    }

    func setOnUpdate(_ handler: @escaping (LibraryPayload) -> Void) {
        onUpdate = handler
    }

    func clear() {
        crawlTask?.cancel()
        crawlTask = nil
        quickTask?.cancel()
        quickTask = nil
        library = nil
        transientTracks = [:]
        try? FileManager.default.removeItem(at: cacheURL)
    }

    // MARK: Loading

    /// Returns something to show as soon as possible: the disk cache, or a quick
    /// fetch of playlists + Liked Songs. The full crawl continues in the background.
    func load(forceRefresh: Bool) async throws -> LibraryPayload {
        if forceRefresh {
            crawlTask?.cancel()
            crawlTask = nil
        }
        if !forceRefresh, let lib = library ?? readCache() {
            library = lib
            if !lib.crawlComplete || Date().timeIntervalSince(lib.fetchedAt) > Self.staleAfter {
                startCrawl(refetchPlaylists: Date().timeIntervalSince(lib.fetchedAt) > Self.staleAfter)
            }
            return lib.payload
        }
        let lib = try await quickFetch()
        library = lib
        writeCache(lib)
        startCrawl(refetchPlaylists: true)
        return lib.payload
    }

    /// Profile + playlists + Liked Songs: enough to boot the iPod.
    private func quickFetch() async throws -> Library {
        if let quickTask { return try await quickTask.value }
        let task = Task<Library, Error> { [api] in
            let profile = try? await api.me()
            let playlists = try await api.playlists()
            let liked = try await api.savedTracks()
            var lib = Library(userID: profile?.id, playlists: playlists, likedSongs: liked, playlistTracks: [:], followedArtists: [], savedAlbums: [], fetchedAt: Date(), crawlComplete: false)
            lib.derive()
            return lib
        }
        quickTask = task
        defer { quickTask = nil }
        return try await task.value
    }

    /// Walks every playlist (sequentially, to stay under Spotify's rate limit),
    /// then followed artists and saved albums, streaming the growing library.
    private func startCrawl(refetchPlaylists: Bool) {
        guard crawlTask == nil else { return }
        crawlTask = Task { [weak self] in
            await self?.crawl(refetchPlaylists: refetchPlaylists)
            await self?.crawlFinished()
        }
    }

    private func crawlFinished() {
        crawlTask = nil
    }

    private func crawl(refetchPlaylists: Bool) async {
        guard var lib = library else { return }
        var lastEmit = Date()
        func publish(force: Bool = false) {
            guard force || Date().timeIntervalSince(lastEmit) > 3 else { return }
            lastEmit = Date()
            lib.derive()
            library = lib
            onUpdate?(lib.payload)
        }

        if refetchPlaylists, let fresh = try? await api.playlists() {
            lib.playlists = fresh
            // Drop cached contents for playlists that changed their snapshot.
            let snapshots = Dictionary(uniqueKeysWithValues: fresh.map { ($0.id, $0.snapshotID ?? "") })
            for (id, old) in lib.playlistSnapshots where snapshots[id] != old {
                lib.playlistTracks[id] = nil
            }
            lib.playlistTracks = lib.playlistTracks.filter { snapshots[$0.key] != nil }
            if let liked = try? await api.savedTracks() { lib.likedSongs = liked }
            publish(force: true)
        }

        for playlist in lib.playlists where lib.playlistTracks[playlist.id] == nil {
            if Task.isCancelled { return }
            do {
                let tracks = try await api.playlistTracks(id: playlist.id)
                lib.playlistTracks[playlist.id] = tracks
                lib.playlistSnapshots[playlist.id] = playlist.snapshotID ?? ""
                publish()
            } catch {
                log.error("playlist \(playlist.name, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                if case SpotifyWebAPI.APIError.http(let code, _) = error, code == 401 { return }
            }
        }
        if Task.isCancelled { return }
        if let followed = try? await api.followedArtists() { lib.followedArtists = followed }
        if let albums = try? await api.savedAlbums() { lib.savedAlbums = albums }
        lib.crawlComplete = lib.playlists.allSatisfy { lib.playlistTracks[$0.id] != nil }
        lib.fetchedAt = Date()
        publish(force: true)
        writeCache(lib)
        log.info("library: \(lib.songs.count) songs, \(lib.artists.count) artists, \(lib.albums.count) albums, \(lib.playlists.count) playlists")
    }

    // MARK: Track lists

    func playlistTracks(id: String) async throws -> [Track] {
        if id == Self.likedPlaylistID { return library?.likedSongs ?? [] }
        if let t = library?.playlistTracks[id] { return t }
        let t = try await api.playlistTracks(id: id)
        if var lib = library {
            lib.playlistTracks[id] = t
            lib.derive()
            library = lib
        }
        return t
    }

    func albumTracks(id: String) async throws -> [Track] {
        if let t = transientTracks["al:\(id)"] { return t }
        let album = library?.albums.first { $0.id == id } ?? Album(id: id, uri: "spotify:album:\(id)", name: "", artistName: "")
        let t = try await api.albumTracks(album: album)
        transientTracks["al:\(id)"] = t
        return t
    }

    func artistTracks(id: String) async throws -> [Track] {
        if let t = transientTracks["ar:\(id)"] { return t }
        var t = (library?.songs ?? []).filter { $0.artistIds.contains(id) }
        if t.isEmpty { t = try await api.artistTopTracks(id: id) }
        transientTracks["ar:\(id)"] = t
        return t
    }

    // MARK: Cache

    private func readCache() -> Library? {
        guard let data = try? Data(contentsOf: cacheURL) else { return nil }
        guard var lib = try? JSONDecoder().decode(Library.self, from: data) else { return nil }
        lib.derive()
        return lib
    }

    private func writeCache(_ lib: Library) {
        if let data = try? JSONEncoder().encode(lib) {
            try? data.write(to: cacheURL, options: .atomic)
        }
    }
}

// MARK: - Library model

struct Library: Codable {
    var userID: String?
    var playlists: [Playlist]
    var likedSongs: [Track]
    var playlistTracks: [String: [Track]]
    var playlistSnapshots: [String: String] = [:]
    var followedArtists: [Artist]
    var savedAlbums: [Album]
    var fetchedAt: Date
    var crawlComplete: Bool

    // Derived (not persisted).
    private(set) var songs: [Track] = []
    private(set) var artists: [Artist] = []
    private(set) var albums: [Album] = []

    enum CodingKeys: String, CodingKey {
        case userID, playlists, likedSongs, playlistTracks, playlistSnapshots, followedArtists, savedAlbums, fetchedAt, crawlComplete
    }

    init(userID: String?, playlists: [Playlist], likedSongs: [Track], playlistTracks: [String: [Track]], followedArtists: [Artist], savedAlbums: [Album], fetchedAt: Date, crawlComplete: Bool) {
        self.userID = userID
        self.playlists = playlists
        self.likedSongs = likedSongs
        self.playlistTracks = playlistTracks
        self.followedArtists = followedArtists
        self.savedAlbums = savedAlbums
        self.fetchedAt = fetchedAt
        self.crawlComplete = crawlComplete
    }

    var likedPlaylist: Playlist {
        let uri = userID.map { "spotify:user:\($0):collection" } ?? "spotify:collection:tracks"
        return Playlist(id: LibraryStore.likedPlaylistID, uri: uri, name: "Liked Songs", trackCount: likedSongs.count, snapshotID: nil)
    }

    var payload: LibraryPayload {
        LibraryPayload(playlists: [likedPlaylist] + playlists, artists: artists, albums: albums, songs: songs)
    }

    /// Rebuilds Songs / Artists / Albums from the raw lists.
    mutating func derive() {
        var songsByURI: [String: Track] = [:]
        var order: [String] = []
        func add(_ t: Track) {
            if songsByURI[t.uri] == nil { order.append(t.uri) }
            songsByURI[t.uri] = t
        }
        likedSongs.forEach(add)
        for playlist in playlists {
            playlistTracks[playlist.id]?.forEach(add)
        }
        let all = order.compactMap { songsByURI[$0] }
        songs = all.sorted { LibraryStore.sortKey($0.name) < LibraryStore.sortKey($1.name) }

        var artistsByID: [String: Artist] = [:]
        for artist in followedArtists { artistsByID[artist.id] = artist }
        for track in all {
            let names = track.artistName.components(separatedBy: ", ")
            for (i, id) in track.artistIds.enumerated() where artistsByID[id] == nil {
                artistsByID[id] = Artist(id: id, uri: "spotify:artist:\(id)", name: i < names.count ? names[i] : track.artistName)
            }
        }
        artists = artistsByID.values.sorted { LibraryStore.sortKey($0.name) < LibraryStore.sortKey($1.name) }

        var albumsByID: [String: Album] = [:]
        for album in savedAlbums { albumsByID[album.id] = album }
        for track in all {
            guard let id = track.albumId, albumsByID[id] == nil, !track.albumName.isEmpty else { continue }
            albumsByID[id] = Album(id: id, uri: "spotify:album:\(id)", name: track.albumName, artistName: track.artistName)
        }
        albums = albumsByID.values.sorted {
            let a = LibraryStore.sortKey($0.name), b = LibraryStore.sortKey($1.name)
            return a == b ? $0.artistName < $1.artistName : a < b
        }
    }
}

extension LibraryStore {
    /// iTunes-style sort key: case-insensitive, ignoring a leading article.
    static func sortKey(_ s: String) -> String {
        var k = s.lowercased()
        for article in ["the ", "a ", "an "] where k.hasPrefix(article) {
            k.removeFirst(article.count)
            break
        }
        return k
    }
}
