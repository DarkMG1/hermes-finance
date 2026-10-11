import Foundation

/// When Hermes asks for Face ID: always on a cold launch, and after `grace` seconds or more in the background.
public enum LockPolicy {
    public static let grace: TimeInterval = 30

    /// `awayFor` is the time in the background on a monotonic clock; nil means the app has just launched.
    public static func shouldLock(enabled: Bool, awayFor: TimeInterval?) -> Bool {
        guard enabled else { return false }
        guard let awayFor else { return true }
        return awayFor >= grace
    }
}
