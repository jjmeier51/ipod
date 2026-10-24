import Foundation
import WebKit

/// JS ↔ native message channel.
///
/// The page posts `{id, method, args}` to the `ipod` handler; the answer goes back
/// through `IPOD.bridge._resolve(id, result)` / `_reject(id, message)`. Native
/// pushes events with `IPOD.bridge._emit(name, payload)`.
@MainActor
final class WebBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "ipod"

    typealias Router = (_ method: String, _ args: Data) async throws -> Encodable

    var router: Router?
    private weak var webView: WKWebView?
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    func attach(_ webView: WKWebView) {
        self.webView = webView
    }

    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let method = body["method"] as? String else { return }
        let argsObject = body["args"] ?? [String: Any]()
        let argsData = (try? JSONSerialization.data(withJSONObject: argsObject)) ?? Data("{}".utf8)
        Task { @MainActor in
            await self.dispatch(id: id, method: method, args: argsData)
        }
    }

    private func dispatch(id: Int, method: String, args: Data) async {
        guard let router else {
            reject(id: id, message: "No router")
            return
        }
        do {
            let result = try await router(method, args)
            let json = try encode(result)
            evaluate("IPOD.bridge._resolve(\(id), \(json));")
        } catch {
            reject(id: id, message: error.localizedDescription)
        }
    }

    private func reject(id: Int, message: String) {
        let escaped = (try? encode(message)) ?? "\"error\""
        evaluate("IPOD.bridge._reject(\(id), \(escaped));")
    }

    func emit<T: Encodable>(_ event: String, _ payload: T) {
        guard let name = try? encode(event), let json = try? encode(payload) else { return }
        evaluate("IPOD.bridge._emit(\(name), \(json));")
    }

    private func encode<T: Encodable>(_ value: T) throws -> String {
        let data = try encoder.encode(AnyEncodable(value))
        var s = String(decoding: data, as: UTF8.self)
        // JSON is valid JS except for these two separators.
        s = s.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return s
    }

    private func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js) { _, error in
            #if DEBUG
            if let error { print("bridge js error:", error) }
            #endif
        }
    }
}

/// Type-erasing wrapper so `Encodable` existentials can go through `JSONEncoder`.
struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init(_ value: Encodable) { encodeFn = value.encode }
    func encode(to encoder: Encoder) throws { try encodeFn(encoder) }
}
