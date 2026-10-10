import SwiftUI
import UIKit

/// An opaque window above the app, sheets included, so the app switcher never shows balances.
/// With `locked` it also offers Unlock.
@MainActor
final class PrivacyCover {
    private var window: UIWindow?

    func show(locked: Bool, unlock: @escaping () -> Void) {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let window = self.window ?? UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        // follow the app's own appearance setting, which lives on its main window
        window.overrideUserInterfaceStyle = scene.windows.first { $0 !== window }?.traitCollection.userInterfaceStyle ?? .unspecified
        let cover = CoverView(locked: locked, unlock: unlock)
        if let host = window.rootViewController as? UIHostingController<CoverView> {
            host.rootView = cover
        } else {
            window.rootViewController = UIHostingController(rootView: cover)
        }
        // no keyboard may stay live under the cover, and VoiceOver must not reach the app beneath it
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        window.rootViewController?.view.accessibilityViewIsModal = true
        window.makeKeyAndVisible()
        self.window = window
    }

    func hide() {
        guard let window else { return }
        window.windowScene?.windows.first { $0 !== window }?.makeKey()
        window.isHidden = true
    }
}

private struct CoverView: View {
    let locked: Bool
    let unlock: () -> Void

    var body: some View {
        VStack(spacing: Space.xl) {
            Text("Hermes").textStyle(.display)
            if locked { HButton(title: "Unlock", action: unlock) }
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
    }
}
