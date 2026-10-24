import Foundation

/// The user's Spotify library shaped like an iPod library: playlists, artists,
/// albums and songs. Cached on disk so the iPod boots instantly next time;
/// refreshed in the background.
actor LibraryStore {
    private let api: SpotifyWebAPI
    private var library: Library?
    private var trackCache: [String: [Track]] = [:]
    private var loadTask: Task<Library, Error>?
    private let cacheURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("library.json")
    }()
    private static let staleAfter: TimeInterval = 60 * 30

    init(api: SpotifyWebAPI) {
        self.api = api
    }

    func clear() {
        library = nil
        trackCache = [:]
        loadTask?.cancel()
        loadTask = nil
        try? FileManager.default.removeItem(at: cacheURL)
    }

    /// Returns the cached library right away when there is one (refreshing in the
    /// background if stale), otherwise fetches everything.
    func load(forceRefresh: Bool) async throws -> Library {
        if !forceRefresh, let library {
            if Date().timeIntervalSince(library.fetchedAt) > Self.staleAfter { refreshInBackground() }
            return library
        }
        if !forceRefresh, let cached = readCache() {
            library = cached
            if Date().timeIntervalSince(cached.fetchedAt) > Self.staleAfter { refreshInBackground() }
            return cached
        }
        return try await fetchAll()
    }

    /// Called with the fresh library after a background refresh.
    var onUpdate: ((Library) -> Void)?

    private func refreshInBackground() {
        guard loadTask == nil else { return }
        Task { [weak self] in
            guard let self, let lib = try? await self.fetchAll() else { return }
            await self.notify(lib)
        }
    }

    private func notify(_ lib: Library) {
        onUpdate?(lib)
    }

    func setOnUpdate(_ handler: @escaping (Library) -> Void) {
        onUpdate = handler
    }

    private func fetchAll() async throws -> Library {
        if let loadTask { return try await loadTask.value }
        let task = Task<Library, Error> { [api] in
            async let songs = api.savedTracks()
            async let playlists = api.playlists()
            async let followed = api.followedArtists()
            async let albums = api.savedAlbums()
            let (s, p, f, a) = try await (songs, playlists, followed, albums)

            // Artists = followed ∪ artists of liked songs, like an iPod's Artists list.
            var artistsByID: [String: Artist] = [:]
            for artist in f { artistsByID[artist.id] = artist }
            for track in s {
                for (i, id) in track.artistIds.enumerated() where artistsByID[id] == nil {
                    let names = track.artistName.components(separatedBy: ", ")
                    let name = i < names.count ? names[i] : track.artistName
                    artistsByID[id] = Artist(id: id, uri: "spotify:artist:\(id)", name: name)
                }
            }
            let lib = Library(
                playlists: p,
                artists: artistsByID.values.sorted { Self.sortKey($0.name) < Self.sortKey($1.name) },
                albums: a.sorted { Self.sortKey($0.name) < Self.sortKey($1.name) },
                songs: s.sorted { Self.sortKey($0.name) < Self.sortKey($1.name) },
                fetchedAt: Date()
            )
            return lib
        }
        loadTask = task
        defer { loadTask = nil }
        let lib = try await task.value
        library = lib
        trackCache = [:]
        writeCache(lib)
        return lib
    }

    // MARK: Track lists

    func playlistTracks(id: String) async throws -> [Track] {
        if let t = trackCache["pl:\(id)"] { return t }
        let t = try await api.playlistTracks(id: id)
        trackCache["pl:\(id)"] = t
        return t
    }

    func albumTracks(id: String) async throws -> [Track] {
        if let t = trackCache["al:\(id)"] { return t }
        let album = library?.albums.first { $0.id == id } ?? Album(id: id, uri: "spotify:album:\(id)", name: "", artistName: "")
        let t = try await api.albumTracks(album: album)
        trackCache["al:\(id)"] = t
        return t
    }

    func artistTracks(id: String) async throws -> [Track] {
        if let t = trackCache["ar:\(id)"] { return t }
        var t = (library?.songs ?? []).filter { $0.artistIds.contains(id) }
        if t.isEmpty { t = try await api.artistTopTracks(id: id) }
        trackCache["ar:\(id)"] = t
        return t
    }

    // MARK: Cache

    private func readCache() -> Library? {
        guard let data = try? Data(contentsOf: cacheURL) else { return nil }
        return try? JSONDecoder().decode(Library.self, from: data)
    }

    private func writeCache(_ lib: Library) {
        if let data = try? JSONEncoder().encode(lib) {
            try? data.write(to: cacheURL, options: .atomic)
        }
    }

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
