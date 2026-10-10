import Foundation

/// When Hermes asks for Face ID: always on a cold launch, and after `grace` seconds or more in the background.
public enum LockPolicy {
    public static let grace: TimeInterval = 30

    /// `backgroundedAt` nil means the app has just launched.
    public static func shouldLock(enabled: Bool, backgroundedAt: Date?, now: Date) -> Bool {
        guard enabled else { return false }
        guard let backgroundedAt else { return true }
        let elapsed = now.timeIntervalSince(backgroundedAt)
        // a negative elapsed time means the clock was set back: lock rather than trust it
        return elapsed < 0 || elapsed >= grace
    }
}
