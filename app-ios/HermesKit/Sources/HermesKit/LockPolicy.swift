import Foundation

/// When Hermes asks for Face ID: always on a cold launch, and after `grace` seconds or more in the background.
/// While the financial profile is open, on every return, even with the lock off: it keeps its screens and drafts behind the lock.
public enum LockPolicy {
    public static let grace: TimeInterval = 30

    /// `awayFor` is the time in the background on a monotonic clock; nil means the app has just launched.
    public static func shouldLock(enabled: Bool, awayFor: TimeInterval?, profileOpen: Bool = false) -> Bool {
        if profileOpen { return true }
        guard enabled else { return false }
        guard let awayFor else { return true }
        return awayFor >= grace
    }
}
