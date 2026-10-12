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
    let body = CreateTransactionBody(date: "2026-03-01", amountCents: -1, payee: "Synthetic", categoryId: nil, notes: nil)
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

@Test func holdingKeyWithSlashStaysInTheQuery() async throws {
    let transport = FakeTransport([FakeTransport.json(200, "{}")])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let holding = Holding(key: "SYN/D", name: "Synthetic D Class", ticker: "SYN/D", type: "equity", quantity: 1, priceCents: 1, valueCents: 1,
                          costBasisCents: nil, gainCents: nil, accounts: [])
    _ = try await client.getData("/v1/investments/holding-history", query: holding.historyQuery + NetWorthRange.all.queryItems)
    let request = try #require(transport.requests.first)
    #expect(request.url.absoluteString == "https://hermes.example.com/v1/investments/holding-history?key=SYN/D&range=all")
}

@Test func receiptUploadSendsJPEGWithoutAKey() async throws {
    let transport = FakeTransport([FakeTransport.json(200, #"{"bytes":3}"#)])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    try await client.putReceipt(transactionId: "t1", jpeg: Data([0xFF, 0xD8, 0xFF]))
    let request = try #require(transport.requests.first)
    #expect(request.method == "PUT" && request.url.path() == "/v1/transactions/t1/receipt")
    #expect(request.headers["Content-Type"] == "image/jpeg" && request.headers["Idempotency-Key"] == nil)
    #expect(request.body == Data([0xFF, 0xD8, 0xFF]))
}

@Test func reconcileSendsTheFlag() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("transaction")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    _ = try await client.setReconciled(id: "t1", reconciled: true, idempotencyKey: "k")
    let request = try #require(transport.requests.first)
    #expect(request.url.path() == "/v1/transactions/t1/reconcile" && request.body == Data(#"{"reconciled":true}"#.utf8))
}
