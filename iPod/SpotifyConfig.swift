import Foundation

/// Spotify app registration. The client ID comes from `Config.xcconfig` via Info.plist.
struct SpotifyConfig {
    static let shared = SpotifyConfig()

    let clientID: String
    let redirectURL: URL
    /// Scopes for the Web API (library, playback) and App Remote.
    let scopes: [String] = [
        "app-remote-control",
        "user-read-playback-state",
        "user-modify-playback-state",
        "user-read-currently-playing",
        "user-library-read",
        "playlist-read-private",
        "playlist-read-collaborative",
        "user-follow-read",
        "user-read-private",
        "user-read-email",
    ]

    private init() {
        let info = Bundle.main.infoDictionary ?? [:]
        clientID = (info["SpotifyClientID"] as? String) ?? ""
        let scheme = (info["SpotifyRedirectScheme"] as? String) ?? "ipod-spotify"
        redirectURL = URL(string: "\(scheme)://callback")!
    }

    var isConfigured: Bool {
        !clientID.isEmpty && clientID != "YOUR_SPOTIFY_CLIENT_ID"
    }
}
