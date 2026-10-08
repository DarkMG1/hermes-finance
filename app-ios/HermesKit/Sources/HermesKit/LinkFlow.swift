import Foundation

public enum LinkOutcome: Sendable, Equatable {
    case linked(Bank)
    case cancelled
    case stillPending
}

/// After the Hosted Link sheet closes, ask the server to finish; 202 means Plaid hasn't finished yet.
/// The server never stores a 202, so polling with one key is safe.
public func finishLink(client: APIClient, sessionId: String, key: String, maxAttempts: Int = 30,
                       sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) async throws -> LinkOutcome {
    for attempt in 1...maxAttempts {
        do {
            switch try await client.completeLinkSession(id: sessionId, idempotencyKey: key) {
            case .done(let bank): return .linked(bank)
            case .pending: if attempt < maxAttempts { try await sleep(.seconds(2)) }
            }
        } catch ClientError.api(409, let body) where body.code == "LINK_EXITED" {
            return .cancelled
        }
    }
    return .stillPending
}
