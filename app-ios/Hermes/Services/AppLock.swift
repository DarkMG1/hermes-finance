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

    enum OwnerCheck { case confirmed, failed, facesChanged }

    var onFacesChanged: () -> Void = {}

    /// Someone who knows the passcode can add a face in iOS Settings; a changed enrolled-face state means Face ID no longer proves the owner.
    static func confirmOwner(reason: String) async -> OwnerCheck {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        guard (try? await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)) == true else { return .failed }
        let key = "faceIDDomainState"
        let current = context.domainState.biometry.stateHash
        if let saved = UserDefaults.standard.data(forKey: key), saved != current {
            UserDefaults.standard.removeObject(forKey: key)
            return .facesChanged
        }
        UserDefaults.standard.set(current, forKey: key)
        return .confirmed
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
            switch await Self.confirmOwner(reason: "Unlock Hermes") {
            case .confirmed:
                locked = false
                cover.hide()
            case .failed:
                break
            case .facesChanged:
                locked = false
                cover.hide()
                onFacesChanged()
            }
        }
    }
}
