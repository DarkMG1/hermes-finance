import Testing
@testable import HermesKit

final class Counter: @unchecked Sendable {
    var n = 0
    func next() -> String { n += 1; return "k\(n)" }
}

@Test func unknownOutcomesKeepTheKeyAndLock() {
    let counter = Counter()
    var guardState = WriteGuard(makeKey: { counter.next() })
    #expect(guardState.key == "k1" && !guardState.unresolved)
    guardState.didFail(ClientError.transport("timed out"))
    #expect(guardState.key == "k1" && guardState.unresolved)
    guardState.didFail(ClientError.api(status: 502, body: APIErrorBody(code: "INTERNAL", message: "x")))
    #expect(guardState.key == "k1" && guardState.unresolved)
    guardState.didSucceed()
    #expect(guardState.key == "k2" && !guardState.unresolved)
}

@Test func definiteRejectionsUnlockWithAFreshKey() {
    let counter = Counter()
    var guardState = WriteGuard(makeKey: { counter.next() })
    guardState.didFail(ClientError.transport("offline"))
    guardState.didFail(ClientError.api(status: 400, body: APIErrorBody(code: "INVALID_REQUEST", message: "payee", field: "payee")))
    #expect(guardState.key == "k2" && !guardState.unresolved)
}

@Test func authAndReusedKeyFailuresAfterUnknownOutcomeStayLocked() {
    let counter = Counter()
    var guardState = WriteGuard(makeKey: { counter.next() })
    guardState.didFail(ClientError.transport("timed out"))
    guardState.didFail(ClientError.api(status: 401, body: APIErrorBody(code: "UNAUTHORIZED", message: "x")))
    #expect(guardState.key == "k1" && guardState.unresolved)
    guardState.didFail(ClientError.api(status: 409, body: APIErrorBody(code: "IDEMPOTENCY_KEY_REUSED", message: "x")))
    #expect(guardState.key == "k1" && guardState.unresolved)
}

@Test func authAndReusedKeyFailuresFromAResolvedStateRotate() {
    let counter = Counter()
    var guardState = WriteGuard(makeKey: { counter.next() })
    guardState.didFail(ClientError.api(status: 401, body: APIErrorBody(code: "UNAUTHORIZED", message: "x")))
    #expect(guardState.key == "k2" && !guardState.unresolved)
    guardState.didFail(ClientError.api(status: 409, body: APIErrorBody(code: "IDEMPOTENCY_KEY_REUSED", message: "x")))
    #expect(guardState.key == "k3" && !guardState.unresolved)
}
