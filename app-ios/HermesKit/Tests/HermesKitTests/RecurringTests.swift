import Foundation
import Testing
@testable import HermesKit

private func itemJSON() throws -> Data {
    try JSONEncoder().encode(try JSONDecoder().decode(RecurringList.self, from: try fixture("recurring")).items[0])
}

@Test func recurringFixtureDecodes() throws {
    let list = try JSONDecoder().decode(RecurringList.self, from: try fixture("recurring"))
    #expect(list.items.first?.name == "Synthetic TV" && list.items.first?.priceUpCents == 200)
}

@Test func createRecurringPostsWithAKey() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 201, body: try itemJSON()))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    _ = try await client.createRecurring(body: CreateRecurringBody(transactionId: "t1", frequency: "monthly", name: nil), idempotencyKey: "k")
    let request = try #require(transport.requests.first)
    #expect(request.method == "POST" && request.url.path() == "/v1/recurring" && request.headers["Idempotency-Key"] == "k")
    let body = try #require(request.body)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json.keys.sorted() == ["frequency", "transactionId"])
}

@Test func recurringIncludeHiddenAddsTheQuery() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("recurring")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    _ = try await client.recurring(includeHidden: true)
    #expect(transport.requests.first?.url.query() == "hidden=1")
}

@Test func patchRecurringOmitsNilFields() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try itemJSON()))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    _ = try await client.patchRecurring(id: "r1", body: PatchRecurringBody(hidden: true), idempotencyKey: "k")
    let request = try #require(transport.requests.first)
    #expect(request.method == "PATCH" && request.url.path() == "/v1/recurring/r1")
    let body = try #require(request.body)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json.keys.sorted() == ["hidden"])
}
