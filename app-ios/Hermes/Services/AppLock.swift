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

    /// False when no Face ID is enrolled or available, so there is nothing to unlock with. No passcode fallback.
    static var canUseFaceID: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) }

    static func confirmOwner(reason: String) async -> Bool {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        return (try? await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)) ?? false
    }

    /// Called when the Connect screen succeeds: ask for Face ID right away, as a cold launch does.
    func didConnect(enabled: Bool) {
        launched = true
        backgroundedAt = nil
        if enabled && Self.canUseFaceID {
            locked = true
            cover.show(locked: true) { [weak self] in self?.authenticate() }
            authenticate()
        }
    }

    func phaseChanged(to phase: ScenePhase, enabled: Bool, connected: Bool) {
        guard connected else {
            // not connected: nothing to lock; didConnect locks once the Connect screen succeeds

            launched = true
            locked = false
            backgroundedAt = nil
            if phase == .active { cover.hide() } else { cover.show(locked: false) {} }
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
            if await Self.confirmOwner(reason: "Unlock Hermes") {
                locked = false
                cover.hide()
            }
        }
    }
}
