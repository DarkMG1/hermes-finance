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
    private var failure: String?
    private let onFacesChanged: @MainActor () -> Void

    init(onFacesChanged: @escaping @MainActor () -> Void) {
        self.onFacesChanged = onFacesChanged
    }

    /// False when no Face ID is enrolled or available, so there is nothing to unlock with. No passcode fallback.
    static var canUseFaceID: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) }

    /// Locking depends on this, not `canUseFaceID`: lockout, a reset Face ID, or Face ID turned off for Hermes must not open it unlocked.
    /// Remembered once seen: with Face ID turned off for Hermes, iOS may report no biometry at all.
    static var hasBiometricHardware: Bool {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        let seen = UserDefaults.standard.bool(forKey: "biometricHardwareSeen")
        guard context.biometryType != .none else { return seen }
        UserDefaults.standard.set(true, forKey: "biometricHardwareSeen")
        return true
    }

    /// `failed` carries a one-line reason when Face ID can't run at all; nil after a cancel.
    enum OwnerCheck { case confirmed, failed(String?), facesChanged }

    /// Someone who knows the passcode can add a face in iOS Settings; a changed enrolled-face state means Face ID no longer proves the owner.
    static func confirmOwner(reason: String) async -> OwnerCheck {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        var unavailable: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &unavailable) else {
            return .failed(failureMessage(unavailable))
        }
        do {
            guard try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) else { return .failed(nil) }
        } catch {
            return .failed(failureMessage(error))
        }
        let key = "faceIDDomainState"
        let current = context.domainState.biometry.stateHash
        if let saved = UserDefaults.standard.data(forKey: key), saved != current {
            UserDefaults.standard.removeObject(forKey: key)
            return .facesChanged
        }
        UserDefaults.standard.set(current, forKey: key)
        return .confirmed
    }

    private static func failureMessage(_ error: Error?) -> String? {
        switch (error as? LAError)?.code {
        case .biometryLockout?: "Face ID is locked. Unlock your iPhone with its passcode, then tap Unlock."
        case .biometryNotEnrolled?: "Set up Face ID in iOS Settings, then tap Unlock."
        case .biometryNotAvailable?: "Allow Face ID for Hermes in iOS Settings, then tap Unlock."
        default: nil
        }
    }

    private func showLocked() {
        cover.show(locked: true, message: failure) { [weak self] in self?.authenticate() }
    }

    /// Called when the Connect screen succeeds: ask for Face ID right away, as a cold launch does.
    func didConnect(enabled: Bool) {
        launched = true
        backgroundedAt = nil
        if enabled && Self.hasBiometricHardware {
            locked = true
            failure = nil
            showLocked()
            authenticate()
        }
    }

    func phaseChanged(to phase: ScenePhase, enabled: Bool, connected: Bool) {
        guard connected else {
            // not connected: nothing to lock; didConnect locks once the Connect screen succeeds

            launched = true
            locked = false
            backgroundedAt = nil
            if phase == .active { cover.hide() } else { cover.show(locked: false, message: nil) {} }
            return
        }
        switch phase {
        case .background:
            if backgroundedAt == nil { backgroundedAt = .now }
            cover.show(locked: locked, message: failure) { [weak self] in self?.authenticate() }
        case .inactive:
            cover.show(locked: locked, message: failure) { [weak self] in self?.authenticate() }
        case .active:
            // the Face ID prompt itself makes the app inactive then active again: that return has no backgroundedAt, so it never re-prompts
            let due = !launched || backgroundedAt != nil
            let now = Date.now
            let shouldLock = due && Self.hasBiometricHardware
                && LockPolicy.shouldLock(enabled: enabled, backgroundedAt: launched ? backgroundedAt : nil, now: now)
            launched = true
            backgroundedAt = nil
            if shouldLock {
                locked = true
                failure = nil
                showLocked()
                authenticate()
            } else if locked && enabled {
                showLocked()
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
                failure = nil
                cover.hide()
            case .failed(let message):
                failure = message
                if locked { showLocked() }
            case .facesChanged:
                onFacesChanged()
                locked = false
                failure = nil
                cover.hide()
            }
        }
    }
}
