import SwiftUI
import UIKit

/// The Home Screen "Snap receipt" action; the app opens the camera once it is connected (Face ID's cover sits above it).
@MainActor @Observable
final class QuickActions {
    static let shared = QuickActions()
    var snapRequests = 0
    static let snapType = "snapReceipt"
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connecting: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if options.shortcutItem?.type == QuickActions.snapType { Task { @MainActor in QuickActions.shared.snapRequests += 1 } }
        let config = UISceneConfiguration(name: nil, sessionRole: connecting.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem) async -> Bool {
        guard shortcutItem.type == QuickActions.snapType else { return false }
        await MainActor.run { QuickActions.shared.snapRequests += 1 }
        return true
    }
}
