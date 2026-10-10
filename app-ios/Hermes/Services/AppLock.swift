import HermesKit
import LocalAuthentication
import SwiftUI

/// Face ID on a cold launch and after `LockPolicy.grace` seconds away; the privacy cover whenever the app isn't active.
@MainActor @Observable
final class AppLock {
    private let cover = PrivacyCover()
    private var locked = false
    private var launched = false
    private var backgroundedAt: Date?
    private var authenticating = false

    /// False when the device has neither Face ID nor a passcode, so there is nothing to unlock with.
    static var canUseFaceID: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }

    func phaseChanged(to phase: ScenePhase, enabled: Bool, connected: Bool) {
        guard connected else {
            locked = false
            cover.hide()
            return
        }
        switch phase {
        case .background:
            if backgroundedAt == nil { backgroundedAt = .now }
            cover.show(locked: locked) { [weak self] in self?.authenticate() }
        case .inactive:
            cover.show(locked: locked) { [weak self] in self?.authenticate() }
        case .active:
            // the Face ID prompt itself makes the app inactive then active again: that return has no backgroundedAt, so it never re-prompts
            let due = !launched || backgroundedAt != nil
            let now = Date.now
            let shouldLock = due && Self.canUseFaceID
                && LockPolicy.shouldLock(enabled: enabled, backgroundedAt: launched ? backgroundedAt : nil, now: now)
            launched = true
            backgroundedAt = nil
            if shouldLock {
                locked = true
                cover.show(locked: true) { [weak self] in self?.authenticate() }
                authenticate()
            } else if locked && enabled {
                cover.show(locked: true) { [weak self] in self?.authenticate() }
            } else {
                locked = false
                cover.hide()
            }
        @unknown default:
            break
        }
    }

    private func authenticate() {
        guard !authenticating else { return }
        authenticating = true
        Task {
            defer { authenticating = false }
            let unlocked = (try? await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Hermes")) ?? false
            if unlocked {
                locked = false
                cover.hide()
            }
        }
    }
}
