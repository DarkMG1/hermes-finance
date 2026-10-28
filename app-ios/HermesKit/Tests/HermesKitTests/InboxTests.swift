import Foundation
import Testing
@testable import HermesKit

@Test func inboxFixturesDecode() throws {
    let list: InboxList = try JSONDecoder().decode(InboxList.self, from: try fixture("inbox"))
    #expect(list.waiting.first?.id == "inbox-1" && list.waiting.first?.status == "read" && list.waiting.first?.totalCents == 640)
    #expect(list.waiting.first?.payee == "Synthetic Grocer")
    #expect(list.waiting.first?.forPersonId == "person-1")
    #expect(list.waiting.first?.taggedPersonIds == ["person-1"])
    #expect(list.recentlyLinked.first?.transactionId == "txn-1" && list.recentlyLinked.first?.splitApplied == true)
    let items = try JSONDecoder().decode(Itemization.self, from: try fixture("inbox-items"))
    #expect(items.items.first?.people == ["me", "person-1"])
    _ = try JSONDecoder().decode(LinkedReceipt.self, from: try fixture("inbox-linked"))
}

@Test func inboxDecodesWithoutPersonFieldsFromOlderServer() throws {
    var json = try #require(JSONSerialization.jsonObject(with: fixture("inbox")) as? [String: Any])
    var waiting = try #require(json["waiting"] as? [[String: Any]])
    waiting[0].removeValue(forKey: "forPersonId")
    waiting[0].removeValue(forKey: "taggedPersonIds")
    json["waiting"] = waiting
    let list = try JSONDecoder().decode(InboxList.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(list.waiting.first?.forPersonId == nil)
    #expect(list.waiting.first?.taggedPersonIds == nil)
    #expect(list.waiting.first?.subtitle(day: "Today", personName: { _ in "Someone" }) == "Today · Split")
}

@Test func inboxSubtitleKeepsTagsAndSuggestionsTogether() throws {
    let suggestion = try decode(LedgerTransaction.self, "transaction")
    func subtitle(status: String = "read", tagged: Bool = true, people: [String]? = ["p1"],
                  forPerson: String? = nil, suggestions: [LedgerTransaction] = []) -> String {
        let receipt = InboxReceipt(id: "r1", capturedAt: "2026-03-10T18:00:00.000Z", status: status,
                                   merchant: nil, purchaseDate: nil, totalCents: nil, tagged: tagged,
                                   forPersonId: forPerson, taggedPersonIds: people, payee: nil, suggestions: suggestions)
        return receipt.subtitle(day: "Today", personName: { $0 == "p1" ? "Synthetic Quill" : "Synthetic Wren" })
    }
    #expect(subtitle() == "Today · Split with Synthetic Quill")
    #expect(subtitle(suggestions: [suggestion]) == "Today · Split with Synthetic Quill · 1 suggestion")
    #expect(subtitle(people: ["p1", "p2"], suggestions: [suggestion, suggestion]) == "Today · Split with 2 people · 2 suggestions")
    #expect(subtitle(forPerson: "p2", suggestions: [suggestion]) == "Today · For Synthetic Wren · 1 suggestion")
    #expect(subtitle(tagged: false, forPerson: "p1") == "Today · For Synthetic Quill")
    #expect(subtitle(tagged: false) == "Today · Waiting for the charge")
    #expect(subtitle(people: []) == "Today · Waiting for the charge")
    #expect(subtitle(tagged: false, suggestions: [suggestion]) == "Today · 1 suggestion")
    #expect(subtitle(status: "reading", tagged: false) == "Today · Reading…")
    #expect(subtitle(status: "failed", tagged: false) == "Today · Couldn't read")
    #expect(subtitle(status: "reading", forPerson: "p1") == "Today · Reading… · For Synthetic Quill")
    #expect(subtitle(status: "failed", forPerson: "p1") == "Today · Couldn't read · For Synthetic Quill")
}

@Test func inboxForSendsThePersonOrExplicitNullWithAKey() async throws {
    let list = try JSONSerialization.jsonObject(with: fixture("inbox")) as? [String: Any]
    let waiting = try #require(list?["waiting"] as? [[String: Any]])
    for personId in ["person-1", nil] {
        var receipt = waiting[0]
        receipt["forPersonId"] = personId.map { $0 as Any } ?? NSNull()
        let response = try JSONSerialization.data(withJSONObject: receipt)
        let transport = FakeTransport([.success(HTTPResponse(status: 200, body: response))])
        let client = APIClient(baseURL: testBase, token: "t", transport: transport)
        let saved = try await client.setInboxFor(id: "r1", body: InboxForBody(personId: personId), idempotencyKey: "for")
        #expect(saved.forPersonId == personId)
        let request = try #require(transport.requests.first)
        #expect(request.method == "PUT" && request.url.path() == "/v1/receipts/inbox/r1/for" && request.headers["Idempotency-Key"] == "for")
        let body = try #require(request.body)
        let sent = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        if let personId { #expect(sent["personId"] as? String == personId) } else { #expect(sent["personId"] is NSNull) }
    }
}

@Test func uploadPutsTheJpegWithoutAKey() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: Data(#"{"id":"u1","bytes":3}"#.utf8)))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    try await client.uploadInboxReceipt(id: "u1", jpeg: Data([0xff, 0xd8, 0xff]), capturedAt: Date(timeIntervalSince1970: 0))
    let request = try #require(transport.requests.first)
    #expect(request.method == "PUT" && request.url.path() == "/v1/receipts/inbox/u1")
    #expect(request.headers["Content-Type"] == "image/jpeg" && request.headers["Idempotency-Key"] == nil)
    #expect(request.headers["x-captured-at"] == "1970-01-01T00:00:00Z")
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

@Test func rejectedReceiptLinkKeepsCreatedPaymentLockedForRetry() throws {
    let created = try JSONDecoder().decode(LedgerTransaction.self, from: fixture("transaction"))
    var pending = PendingReceiptLink()
    #expect(pending.target == nil && pending.allows("other"))
    pending.createdPayment = created
    pending.unlinked = created
    var writes = WriteGuard()
    let key = writes.key
    writes.didFail(ClientError.transport("timed out"))
    #expect(writes.unresolved && writes.key == key)
    #expect(pending.target?.id == created.id && pending.allows(created.id) && !pending.allows("other"))

    writes.didFail(ClientError.api(status: 409, body: APIErrorBody(code: "HAS_RECEIPT", message: "already linked")))
    if !writes.unresolved { pending.unlinked = nil }
    #expect(!writes.unresolved && pending.unlinked == nil)
    #expect(pending.target?.id == created.id && pending.allows(created.id) && !pending.allows("other"))
    writes.didSucceed()
    pending = PendingReceiptLink()
    #expect(pending.target == nil && pending.allows("other"))
}

@Test func rejectedExistingChargeLinkReleasesItsTarget() throws {
    let charge = try JSONDecoder().decode(LedgerTransaction.self, from: fixture("transaction"))
    var pending = PendingReceiptLink()
    pending.unlinked = charge
    #expect(pending.target?.id == charge.id && !pending.allows("other"))
    var writes = WriteGuard()
    writes.didFail(ClientError.api(status: 404, body: APIErrorBody(code: "NOT_FOUND", message: "not found")))
    if !writes.unresolved { pending.unlinked = nil }
    #expect(pending.target == nil && pending.allows("other"))
}

@Test func paidByCreationSendsItsInboxReceiptAndDecodesTheLinkedTransaction() async throws {
    var json = try #require(JSONSerialization.jsonObject(with: fixture("transaction")) as? [String: Any])
    json["hasReceipt"] = true
    let response = try JSONSerialization.data(withJSONObject: json)
    let transport = FakeTransport([.success(HTTPResponse(status: 201, body: response))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let body = CreateTransactionBody(date: "2026-03-10", amountCents: -600, payee: "Synthetic Quill",
                                     categoryId: nil, notes: nil, paidByPersonId: "p1", inboxReceiptId: "r1")
    let created = try await client.createTransaction(body, idempotencyKey: "paid")
    #expect(created.hasReceipt == true)
    let request = try #require(transport.requests.first)
    #expect(request.url.path() == "/v1/transactions" && request.headers["Idempotency-Key"] == "paid")
    let encoded = try #require(request.body)
    let sent = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(sent["inboxReceiptId"] as? String == "r1" && sent["paidByPersonId"] as? String == "p1")
}
