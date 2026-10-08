import Foundation
import Testing
@testable import HermesKit

private let pending = FakeTransport.json(202, #"{"code":"LINK_PENDING","message":"bank linking not finished yet"}"#)

@Test func pollsUntilDoneWithTheSameKey() async throws {
    let transport = FakeTransport([pending, pending, .success(HTTPResponse(status: 200, body: try fixture("link-complete")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let outcome = try await finishLink(client: client, sessionId: "s1", key: "k1", sleep: { _ in })
    guard case .linked(let bank) = outcome else { Issue.record("expected linked"); return }
    #expect(bank.status == "ok")
    #expect(transport.requests.count == 3 && Set(transport.requests.compactMap { $0.headers["Idempotency-Key"] }) == ["k1"])
}

@Test func exitedMeansCancelledAndExhaustionMeansStillPending() async throws {
    let exited = FakeTransport([FakeTransport.json(409, #"{"code":"LINK_EXITED","message":"bank linking was cancelled"}"#)])
    let exitedClient = APIClient(baseURL: testBase, token: "t", transport: exited)
    #expect(try await finishLink(client: exitedClient, sessionId: "s", key: "k", sleep: { _ in }) == .cancelled)
    let slow = FakeTransport([pending, pending, pending])
    let slowClient = APIClient(baseURL: testBase, token: "t", transport: slow)
    #expect(try await finishLink(client: slowClient, sessionId: "s", key: "k", maxAttempts: 3, sleep: { _ in }) == .stillPending)
}

@Test func expiredSessionThrows() async {
    let expired = FakeTransport([FakeTransport.json(410, #"{"code":"LINK_SESSION_EXPIRED","message":"link session expired; start again"}"#)])
    let client = APIClient(baseURL: testBase, token: "t", transport: expired)
    await #expect(throws: ClientError.self) {
        try await finishLink(client: client, sessionId: "s", key: "k", sleep: { _ in })
    }
}
