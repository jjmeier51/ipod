import Foundation
import AVFoundation
import MediaPlayer
import UIKit

/// Device-side helpers: system volume, haptics, the wheel's click sound, and
/// launching the Spotify app.
@MainActor
final class SystemServices: NSObject {
    var onVolumeChange: ((Double) -> Void)?

    private let session = AVAudioSession.sharedInstance()
    private var volumeObservation: NSKeyValueObservation?
    private lazy var volumeView: MPVolumeView = {
        let v = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
        v.alpha = 0.01
        v.isUserInteractionEnabled = false
        return v
    }()
    private var volumeSlider: UISlider? { volumeView.subviews.compactMap { $0 as? UISlider }.first }
    private var suppressVolumeEvents = 0

    private let lightImpact = UIImpactFeedbackGenerator(style: .light)
    private let mediumImpact = UIImpactFeedbackGenerator(style: .medium)
    private let rigidImpact = UIImpactFeedbackGenerator(style: .rigid)
    private var clickPlayers: [AVAudioPlayer] = []
    private var nextClickPlayer = 0

    override init() {
        super.init()
        installVolumeView()
        volumeObservation = session.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
            guard let self, let v = change.newValue else { return }
            Task { @MainActor in
                if self.suppressVolumeEvents > 0 { self.suppressVolumeEvents -= 1; return }
                self.onVolumeChange?(Double(v) * 100)
            }
        }
        if let url = Bundle.main.url(forResource: "click", withExtension: "wav") {
            for _ in 0..<4 {
                if let p = try? AVAudioPlayer(contentsOf: url) {
                    p.volume = 0.3
                    p.prepareToPlay()
                    clickPlayers.append(p)
                }
            }
        }
        lightImpact.prepare()
        mediumImpact.prepare()
        rigidImpact.prepare()
    }

    private func installVolumeView() {
        // MPVolumeView must be in a window for its slider to drive the system volume.
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap({ $0.windows }).first {
            window.addSubview(volumeView)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.installVolumeView() }
        }
    }

    // MARK: Volume

    var volume: Double {
        Double(session.outputVolume) * 100
    }

    func setVolume(_ percent: Double) {
        let v = Float(min(max(percent, 0), 100) / 100)
        guard let slider = volumeSlider else { return }
        suppressVolumeEvents += 1
        slider.setValue(v, animated: false)
        slider.sendActions(for: .touchUpInside)
    }

    // MARK: Haptics and clicker

    func haptic(kind: String) {
        switch kind {
        case "medium": mediumImpact.impactOccurred()
        case "rigid": rigidImpact.impactOccurred()
        default: lightImpact.impactOccurred(intensity: 0.7)
        }
    }

    /// One wheel detent: the 2004 clicker sound plus a light tap.
    func click() {
        if !clickPlayers.isEmpty {
            let p = clickPlayers[nextClickPlayer % clickPlayers.count]
            nextClickPlayer += 1
            p.currentTime = 0
            p.play()
        }
        lightImpact.impactOccurred(intensity: 0.5)
    }

    // MARK: Spotify app

    var isSpotifyInstalled: Bool {
        UIApplication.shared.canOpenURL(URL(string: "spotify:")!)
    }

    func openSpotify() {
        let url = isSpotifyInstalled ? URL(string: "spotify:")! : URL(string: "https://apps.apple.com/app/spotify-music-and-podcasts/id324684580")!
        UIApplication.shared.open(url)
    }
}
