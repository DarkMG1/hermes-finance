import Foundation
import Testing
@testable import HermesKit

@Test func personFixtureHasTotals() throws {
    let detail = try JSONDecoder().decode(PersonDetail.self, from: try fixture("person"))
    #expect(detail.spentOnThemCents != nil && detail.forgivenCents != nil)
}

@Test func forgivePostsWithAKey() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 201, body: try fixture("transaction")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    _ = try await client.forgive(personId: "p1", body: ForgiveBody(amountCents: 1500, date: "2026-03-10", categoryId: nil, notes: nil), idempotencyKey: "k")
    let request = try #require(transport.requests.first)
    #expect(request.method == "POST" && request.url.path() == "/v1/people/p1/forgive" && request.headers["Idempotency-Key"] == "k")
    let body = try #require(request.body)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json["amountCents"] as? Int == 1500 && json["date"] as? String == "2026-03-10")
}
