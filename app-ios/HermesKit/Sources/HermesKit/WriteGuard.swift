import Foundation

/// One per form. Holds the idempotency key across retries of a write whose outcome is unknown,
/// and tells the form to lock its inputs so a retry always resends the same body.
public struct WriteGuard: Sendable {
    public private(set) var key: String
    public private(set) var unresolved = false
    private let makeKey: @Sendable () -> String

    public init(makeKey: @escaping @Sendable () -> String = { UUID().uuidString }) {
        self.makeKey = makeKey
        key = makeKey()
    }

    public mutating func didSucceed() {
        unresolved = false
        key = makeKey()
    }

    public mutating func didFail(_ error: Error) {
        if let error = error as? ClientError, error.isOutcomeUnknown {
            unresolved = true
        } else {
            unresolved = false
            key = makeKey()
        }
    }
}
