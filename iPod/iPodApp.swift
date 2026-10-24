import SwiftUI
import AVFoundation

@main
struct iPodApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var services = Services.shared

    init() {
        // Ambient + mixWithOthers: the wheel's clicks never interrupt Spotify.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(services)
                .onOpenURL { url in
                    services.handle(url: url)
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                services.playback.appDidBecomeActive()
            case .background:
                services.playback.appDidEnterBackground()
            default:
                break
            }
        }
    }
}
