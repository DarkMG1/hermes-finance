import SwiftUI
import UIKit

/// An opaque window above the app, sheets included, so the app switcher never shows balances.
/// With `locked` it also offers Unlock.
@MainActor @Observable
final class PrivacyCover {
    private(set) var isVisible = false
    private var window: UIWindow?
    private weak var previousKey: UIWindow?
    /// Bumped by every show and hide, so a fade that finishes after a newer show or hide can't touch the window.
    private var fadeToken = 0
    private var hiddenFromVoiceOver: [UIWindow] = []
    /// The field that had the keyboard when the cover went up; it gets it back when the cover comes down unlocked.
    private weak var editing: UIResponder?

    func show(locked: Bool, message: String?, unlock: @escaping () -> Void) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { [.foregroundActive, .foregroundInactive].contains($0.activationState) }) ?? scenes.first
        else { return }
        if let stale = self.window, stale.windowScene !== scene {
            restoreVoiceOver()
            stale.isHidden = true
            self.window = nil
        }
        let window = self.window ?? UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        // follow the app's own appearance setting, which lives on its main window
        window.overrideUserInterfaceStyle = scene.windows.first { $0 !== window }?.traitCollection.userInterfaceStyle ?? .unspecified
        let cover = CoverView(locked: locked, message: message, unlock: unlock)
        if let host = window.rootViewController as? UIHostingController<CoverView> {
            host.rootView = cover
        } else {
            window.rootViewController = UIHostingController(rootView: cover)
        }
        // no keyboard may stay live under the cover, and VoiceOver must not reach the app beneath it
        // only a text input in the app's own window (a second show finds the cover itself first responder)
        if editing == nil, let field = UIResponder.current, field is UIKeyInput, (field as? UIView)?.window !== self.window { editing = field }
        // locked: Face ID comes first, and the keyboard stays closed after it
        if locked { editing = nil }
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        window.rootViewController?.view.accessibilityViewIsModal = true
        if let key = scene.keyWindow, key !== window { previousKey = key }
        fadeToken += 1
        window.layer.removeAllAnimations()
        window.alpha = 1
        // VoiceOver reads every window; a modal view only hides its own siblings, so hide the app's windows directly
        for other in scene.windows where other !== window && !other.accessibilityElementsHidden {
            other.accessibilityElementsHidden = true
            hiddenFromVoiceOver.append(other)
        }
        window.makeKeyAndVisible()
        isVisible = true
        UIAccessibility.post(notification: .screenChanged, argument: window.rootViewController?.view)
        self.window = window
    }

    func hide() {
        guard let window else { return }
        restoreVoiceOver()
        (previousKey ?? window.windowScene?.windows.first { $0 !== window })?.makeKey()
        // a quick switch to another app (Venmo, say) and back keeps the cursor where it was
        if let field = editing, (field as? UIView)?.window != nil { field.becomeFirstResponder() }
        editing = nil
        fadeToken += 1
        let token = fadeToken
        UIView.animate(withDuration: 0.2) {
            window.alpha = 0
        } completion: { [weak self] _ in
            guard self?.fadeToken == token else { return }
            window.isHidden = true
            window.alpha = 1
            self?.isVisible = false
        }
    }

    private func restoreVoiceOver() {
        hiddenFromVoiceOver.forEach { $0.accessibilityElementsHidden = false }
        hiddenFromVoiceOver = []
    }
}

private extension UIResponder {
    @MainActor private static weak var found: UIResponder?

    /// The first responder, found by sending an action to nil (UIKit delivers it to the first responder).
    @MainActor static var current: UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(captureFirstResponder), to: nil, from: nil, for: nil)
        return found
    }

    @objc func captureFirstResponder() { UIResponder.found = self }
}

private struct CoverView: View {
    let locked: Bool
    let message: String?
    let unlock: () -> Void

    var body: some View {
        VStack(spacing: Space.xl) {
            Text("Hermes").textStyle(.display)
            if locked {
                HButton(title: "Unlock", action: unlock)
                if let message {
                    Text(message).textStyle(.caption, color: Palette.secondaryText).multilineTextAlignment(.center)
                }
            }
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
    }
}
