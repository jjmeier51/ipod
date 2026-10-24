import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var services: Services
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            (colorScheme == .dark ? Color(red: 0.114, green: 0.114, blue: 0.122) : Color.white)
                .ignoresSafeArea()
            IPodWebView(bridge: services.bridge)
                .ignoresSafeArea()
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
    }
}
