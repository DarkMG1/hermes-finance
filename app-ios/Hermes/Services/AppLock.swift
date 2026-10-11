import HermesKit
import LocalAuthentication
import SwiftUI

/// Face ID on a cold launch and after `LockPolicy.grace` seconds away; the privacy cover whenever the app isn't active.
@MainActor @Observable
final class AppLock {
    private let cover = PrivacyCover()
    private var locked = false
    private var launched = false
    private var backgroundedAt: ContinuousClock.Instant?
    private var authenticating = false
    /// True only between entering the server token and the next background: only then may the current enrollment become the baseline.
    private var trustNewBaseline = false
    private var isActive = false
    /// Bumped on every background and every new lock, so a Face ID result that arrives later can't unlock.
    private var generation = 0
    /// `generation` when Connect was tapped: a background before the connection completes voids the baseline trust.
    private var connectGeneration: Int?
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
    /// With `allowNewBaseline` (the server token was just entered) the current state replaces any saved one;
    /// otherwise a missing or different saved state counts as changed and signs out.
    static func confirmOwner(reason: String, allowNewBaseline: Bool) async -> OwnerCheck {
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
        guard let current = context.domainState.biometry.stateHash else { return .failed(nil) }
        let saved = UserDefaults.standard.data(forKey: baselineKey)
        // right after the server token was entered, the faces enrolled now become the baseline, replacing a stale one
        if allowNewBaseline || saved == current {
            UserDefaults.standard.set(current, forKey: baselineKey)
            return .confirmed
        }
        UserDefaults.standard.removeObject(forKey: baselineKey)
        return .facesChanged
    }

    private static let baselineKey = "faceIDDomainState"

    /// The server token was just entered, so the faces enrolled now are the owner's: the same moment the lock trusts.
    private static func saveBaselineWithoutPrompt() {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        if let current = context.domainState.biometry.stateHash { UserDefaults.standard.set(current, forKey: baselineKey) }
    }

    /// A Face ID check started inside the app (Show balances). The prompt makes the scene inactive, which shows the privacy cover;
    /// hide it as soon as Face ID answers, as an unlock does, instead of after the prompt's dismiss animation.
    func confirmOwnerInApp(reason: String) async -> OwnerCheck {
        let started = generation
        let result = await Self.confirmOwner(reason: reason, allowNewBaseline: false)
        // backgrounded or locked since the prompt: phaseChanged owns the cover
        if generation == started && !locked { cover.hide() }
        return result
    }

    private static func failureMessage(_ error: Error?) -> String? {
        switch (error as? LAError)?.code {
        case .biometryLockout?: "Face ID is locked. Unlock your iPhone with its passcode, then try again."
        case .biometryNotEnrolled?: "Set up Face ID in iOS Settings, then try again."
        case .passcodeNotSet?: "Set a passcode and Face ID in iOS Settings, then try again."
        case .biometryNotAvailable?: "Allow Face ID for Hermes in iOS Settings, then try again."
        default: nil
        }
    }

    private func showLocked() {
        cover.show(locked: true, message: failure) { [weak self] in self?.authenticate() }
    }

    /// Called right before the Connect screen sends the server token.
    func connectStarting() {
        connectGeneration = generation
    }

    func connectFailed() {
        connectGeneration = nil
    }

    /// Called when the Connect screen succeeds: ask for Face ID right away, as a cold launch does.
    /// A restored session (no Connect tap) is locked by `phaseChanged`; locking again here would void its Face ID result.
    func didConnect(enabled: Bool) {
        guard connectGeneration != nil else { return }
        launched = true
        backgroundedAt = nil
        // a face added in iOS Settings while connecting must not become the baseline: that needs no background since the tap
        trustNewBaseline = connectGeneration == generation && isActive
        connectGeneration = nil
        if enabled && Self.hasBiometricHardware {
            generation += 1
            locked = true
            failure = nil
            showLocked()
            authenticate()
        } else if trustNewBaseline {
            Self.saveBaselineWithoutPrompt()
            trustNewBaseline = false
        }
    }

    func phaseChanged(to phase: ScenePhase, enabled: Bool, connected: Bool) {
        isActive = phase == .active
        if phase == .background {
            // adding a face needs iOS Settings, which backgrounds Hermes
            trustNewBaseline = false
            generation += 1
        }
        guard connected else {
            // not connected: nothing to lock; didConnect locks once the Connect screen succeeds.
            // `launched` stays as is: a connection loaded at a later .active (prewarm while locked) still gets the launch lock
            locked = false
            backgroundedAt = nil
            if phase == .active { cover.hide() } else { cover.show(locked: false, message: nil) {} }
            return
        }
        switch phase {
        case .background:
            if backgroundedAt == nil { backgroundedAt = ContinuousClock.now }
            cover.show(locked: locked, message: failure) { [weak self] in self?.authenticate() }
        case .inactive:
            cover.show(locked: locked, message: failure) { [weak self] in self?.authenticate() }
        case .active:
            // the Face ID prompt itself makes the app inactive then active again: that return has no backgroundedAt, so it never re-prompts
            let due = !launched || backgroundedAt != nil
            let awayFor = launched ? backgroundedAt.map { Self.seconds(ContinuousClock.now - $0) } : nil
            let shouldLock = due && Self.hasBiometricHardware && LockPolicy.shouldLock(enabled: enabled, awayFor: awayFor)
            launched = true
            backgroundedAt = nil
            if shouldLock {
                generation += 1
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

    private static func seconds(_ duration: Duration) -> TimeInterval {
        TimeInterval(duration.components.seconds) + TimeInterval(duration.components.attoseconds) / 1e18
    }

    private func authenticate() {
        guard !authenticating else { return }
        authenticating = true
        let started = generation
        Task {
            defer { authenticating = false }
            switch await Self.confirmOwner(reason: "Unlock Hermes", allowNewBaseline: trustNewBaseline) {
            case .confirmed:
                trustNewBaseline = false
                // backgrounded or locked again since the prompt: ignore the success
                guard generation == started else { return }
                locked = false
                failure = nil
                // the scene is still inactive while the prompt dismisses; the unchanged generation proves no background since
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
