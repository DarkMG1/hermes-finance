import Foundation
import Testing
@testable import HermesKit

@Test func getSendsBearerAndBuildsTheURL() async throws {
    let transport = FakeTransport([FakeTransport.json(200, "[]")])
    let client = APIClient(baseURL: testBase, token: "t0k", transport: transport)
    _ = try await client.getData("/v1/transactions", query: [URLQueryItem(name: "q", value: "a b")])
    let request = try #require(transport.requests.first)
    #expect(request.url.absoluteString == "https://hermes.example.com/v1/transactions?q=a%20b")
    #expect(request.headers["Authorization"] == "Bearer t0k")
    #expect(request.headers["Idempotency-Key"] == nil)
    #expect(request.method == "GET")
}

@Test func writesSendTheKeyAndJSON() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 201, body: try fixture("transaction")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let body = CreateTransactionBody(accountId: "a", date: "2026-03-01", amountCents: -1, payee: "Synthetic", categoryId: nil, notes: nil)
    _ = try await client.createTransaction(body, idempotencyKey: "k-1")
    let request = try #require(transport.requests.first)
    #expect(request.method == "POST" && request.headers["Idempotency-Key"] == "k-1" && request.headers["Content-Type"] == "application/json")
}

@Test func errorBodiesBecomeTypedErrors() async throws {
    let transport = FakeTransport([FakeTransport.json(409, #"{"code":"BANK_TRANSACTION","message":"only manual transactions can be deleted"}"#)])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    await #expect(throws: ClientError.api(status: 409, body: APIErrorBody(code: "BANK_TRANSACTION", message: "only manual transactions can be deleted"))) {
        try await client.deleteTransaction(id: "x", idempotencyKey: "k")
    }
}

@Test func noResponseIsATransportError() async {
    let client = APIClient(baseURL: testBase, token: "t", transport: FakeTransport([]))
    let error = await #expect(throws: ClientError.self) { try await client.accounts() }
    #expect(error?.isOutcomeUnknown == true)
}

@Test func linkCompletion202IsPending() async throws {
    let transport = FakeTransport([FakeTransport.json(202, #"{"code":"LINK_PENDING","message":"bank linking not finished yet"}"#)])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let result = try await client.completeLinkSession(id: "s", idempotencyKey: "k")
    #expect(result == .pending)
}
