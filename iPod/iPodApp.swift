import SwiftUI
import AVFoundation

@main
struct iPodApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var services = Services.shared

    init() {
        // Ambient + mixWithOthers: the wheel's clicks never interrupt Spotify.
        // (.ambient already mixes with other audio.)
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.ambient, mode: .default)
            try session.setActive(true)
        } catch {
            print("audio session:", error)
        }
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
                services.system.appDidBecomeActive()
                services.playback.appDidBecomeActive()
            case .background:
                services.playback.appDidEnterBackground()
            default:
                break
            }
        }
    }
}
