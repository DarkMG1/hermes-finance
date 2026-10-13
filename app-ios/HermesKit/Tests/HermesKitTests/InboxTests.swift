import Foundation
import Testing
@testable import HermesKit

@Test func inboxFixturesDecode() throws {
    let list: InboxList = try JSONDecoder().decode(InboxList.self, from: try fixture("inbox"))
    #expect(list.waiting.first?.id == "inbox-1" && list.waiting.first?.status == "read" && list.waiting.first?.totalCents == 640)
    #expect(list.recentlyLinked.first?.transactionId == "txn-1" && list.recentlyLinked.first?.splitApplied == true)
    let items = try JSONDecoder().decode(Itemization.self, from: try fixture("inbox-items"))
    #expect(items.items.first?.people == ["me"])
    _ = try JSONDecoder().decode(LinkedReceipt.self, from: try fixture("inbox-linked"))
}

@Test func uploadPutsTheJpegWithoutAKey() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: Data(#"{"id":"u1","bytes":3}"#.utf8)))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    try await client.uploadInboxReceipt(id: "u1", jpeg: Data([0xff, 0xd8, 0xff]))
    let request = try #require(transport.requests.first)
    #expect(request.method == "PUT" && request.url.path() == "/v1/receipts/inbox/u1")
    #expect(request.headers["Content-Type"] == "image/jpeg" && request.headers["Idempotency-Key"] == nil)
}

@Test func linkPostsTheTransactionWithAKey() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("inbox-linked")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    _ = try await client.linkInboxReceipt(id: "r1", transactionId: "txn-9", idempotencyKey: "k")
    let request = try #require(transport.requests.first)
    #expect(request.method == "POST" && request.url.path() == "/v1/receipts/inbox/r1/link" && request.headers["Idempotency-Key"] == "k")
    let body = try #require(request.body)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json["transactionId"] as? String == "txn-9")
}

@Test func saveInboxItemsPutsWithAKey() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("inbox-items")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let body = SaveItemsBody(items: [.init(name: "A", amountCents: 100, people: ["me"])], taxCents: 0, tipCents: 0, feesCents: 0)
    _ = try await client.saveInboxItems(id: "r1", body: body, idempotencyKey: "k")
    let request = try #require(transport.requests.first)
    #expect(request.method == "PUT" && request.url.path() == "/v1/receipts/inbox/r1/items" && request.headers["Idempotency-Key"] == "k")
}
