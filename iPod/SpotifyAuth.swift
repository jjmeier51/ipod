import Foundation
import AuthenticationServices
import CryptoKit
import UIKit

/// Spotify sign-in with Authorization Code + PKCE (no backend needed).
/// Tokens live in the Keychain and refresh themselves.
@MainActor
final class SpotifyAuth: NSObject {
    struct TokenSet: Codable {
        var accessToken: String
        var refreshToken: String?
        var expiresAt: Date
        var scope: String?

        var isFresh: Bool { expiresAt.timeIntervalSinceNow > 60 }
    }

    enum AuthError: LocalizedError {
        case notConfigured
        case cancelled
        case badCallback
        case tokenExchangeFailed(String)
        case notSignedIn

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Add your Spotify client ID to Config.xcconfig"
            case .cancelled: return "Sign in was cancelled"
            case .badCallback: return "Spotify returned an unexpected callback"
            case .tokenExchangeFailed(let m): return "Token exchange failed: \(m)"
            case .notSignedIn: return "Not signed in to Spotify"
            }
        }
    }

    private static let tokenKey = "pkce-tokens"
    private let config: SpotifyConfig
    private let session = URLSession(configuration: .ephemeral)
    private var tokens: TokenSet? {
        didSet {
            if let tokens, let data = try? JSONEncoder().encode(tokens) {
                Keychain.set(data, for: Self.tokenKey)
            } else {
                Keychain.delete(Self.tokenKey)
            }
            onChange?()
        }
    }
    private var webSession: ASWebAuthenticationSession?
    private var refreshTask: Task<String, Error>?
    var onChange: (() -> Void)?

    init(config: SpotifyConfig) {
        self.config = config
        super.init()
        if let data = Keychain.get(Self.tokenKey), let t = try? JSONDecoder().decode(TokenSet.self, from: data) {
            tokens = t
        }
    }

    var isSignedIn: Bool { tokens != nil }

    /// A token for App Remote: the current one, refreshed if it is about to expire.
    func validAccessToken() async throws -> String {
        guard let current = tokens else { throw AuthError.notSignedIn }
        if current.isFresh { return current.accessToken }
        if let refreshTask { return try await refreshTask.value }
        let task = Task<String, Error> { [weak self] in
            guard let self else { throw AuthError.notSignedIn }
            defer { Task { @MainActor in self.refreshTask = nil } }
            return try await self.refresh(current)
        }
        refreshTask = task
        return try await task.value
    }

    func signOut() {
        tokens = nil
    }

    // MARK: - Interactive sign in

    func signIn() async throws {
        guard config.isConfigured else { throw AuthError.notConfigured }
        let verifier = Self.randomString(64)
        let challenge = Self.challenge(for: verifier)
        var comps = URLComponents(string: "https://accounts.spotify.com/authorize")!
        comps.queryItems = [
            .init(name: "client_id", value: config.clientID),
            .init(name: "response_type", value: "code"),
            .init(name: "redirect_uri", value: config.redirectURL.absoluteString),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "code_challenge", value: challenge),
            .init(name: "scope", value: config.scopes.joined(separator: " ")),
            .init(name: "state", value: Self.randomString(16)),
        ]
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: comps.url!, callbackURLScheme: config.redirectURL.scheme) { url, error in
                if let url { cont.resume(returning: url) }
                else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { cont.resume(throwing: AuthError.cancelled) }
                else { cont.resume(throwing: error ?? AuthError.badCallback) }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            self.webSession = s
            if !s.start() { cont.resume(throwing: AuthError.badCallback) }
        }
        webSession = nil
        guard let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
              let code = items.first(where: { $0.name == "code" })?.value else {
            let err = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "error" })?.value
            throw AuthError.tokenExchangeFailed(err ?? "no code")
        }
        tokens = try await exchange(code: code, verifier: verifier)
    }

    /// Spotify sometimes bounces through the system (e.g. when the Spotify app
    /// handles the login); ASWebAuthenticationSession normally captures the URL
    /// itself so this is a no-op most of the time.
    func handle(callbackURL: URL) {}

    // MARK: - Token endpoint

    private func exchange(code: String, verifier: String) async throws -> TokenSet {
        try await tokenRequest([
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config.redirectURL.absoluteString,
            "client_id": config.clientID,
            "code_verifier": verifier,
        ], previousRefresh: nil)
    }

    private func refresh(_ current: TokenSet) async throws -> String {
        guard let refreshToken = current.refreshToken else {
            tokens = nil
            throw AuthError.notSignedIn
        }
        do {
            let next = try await tokenRequest([
                "grant_type": "refresh_token",
                "refresh_token": refreshToken,
                "client_id": config.clientID,
            ], previousRefresh: refreshToken)
            tokens = next
            return next.accessToken
        } catch AuthError.tokenExchangeFailed(let message) where message.contains("invalid_grant") {
            tokens = nil
            throw AuthError.notSignedIn
        }
    }

    private func tokenRequest(_ form: [String: String], previousRefresh: String?) async throws -> TokenSet {
        var req = URLRequest(url: URL(string: "https://accounts.spotify.com/api/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = form.map { "\($0.key)=\(Self.formEncode($0.value))" }.joined(separator: "&").data(using: .utf8)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw AuthError.tokenExchangeFailed("no response") }
        guard http.statusCode == 200 else {
            throw AuthError.tokenExchangeFailed(String(decoding: data, as: UTF8.self))
        }
        struct Body: Decodable {
            let access_token: String
            let refresh_token: String?
            let expires_in: Double
            let scope: String?
        }
        let body = try JSONDecoder().decode(Body.self, from: data)
        return TokenSet(
            accessToken: body.access_token,
            refreshToken: body.refresh_token ?? previousRefresh,
            expiresAt: Date().addingTimeInterval(body.expires_in),
            scope: body.scope
        )
    }

    // MARK: - PKCE helpers

    private static func randomString(_ length: Int) -> String {
        let chars = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        return String(bytes.map { chars[Int($0) % chars.count] })
    }

    private static func challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func formEncode(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}

extension SpotifyAuth: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}
