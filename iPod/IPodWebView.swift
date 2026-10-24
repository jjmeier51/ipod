import SwiftUI
import WebKit

/// Hosts the iPod page. The page is served from the app bundle through a custom
/// `ipod://` scheme so scripts, fonts and images load with a normal origin.
struct IPodWebView: UIViewRepresentable {
    let bridge: WebBridge

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
        config.userContentController.add(bridge, name: WebBridge.handlerName)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.ignoresViewportScaleLimits = false

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = context.coordinator
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        bridge.attach(webView)
        webView.load(URLRequest(url: BundleSchemeHandler.indexURL))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            // Keep the web view on the bundled page; anything else opens outside.
            if let url = navigationAction.request.url, url.scheme != BundleSchemeHandler.scheme, navigationAction.navigationType == .linkActivated {
                _ = await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        }
    }
}

/// Serves `Web/` from the bundle at `ipod://app/...`.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "ipod"
    static let indexURL = URL(string: "ipod://app/index.html")!

    private static let mimeTypes: [String: String] = [
        "html": "text/html", "css": "text/css", "js": "text/javascript", "json": "application/json",
        "png": "image/png", "svg": "image/svg+xml", "woff2": "font/woff2", "woff": "font/woff",
        "wav": "audio/wav", "mp3": "audio/mpeg", "txt": "text/plain",
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        let path = url.path.isEmpty ? "/index.html" : url.path
        let fileURL = Bundle.main.bundleURL.appendingPathComponent("Web").appendingPathComponent(path)
        guard let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let ext = fileURL.pathExtension.lowercased()
        let mime = Self.mimeTypes[ext] ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": mime.hasPrefix("text/") || mime == "text/javascript" ? "\(mime); charset=utf-8" : mime,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
        ])!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
