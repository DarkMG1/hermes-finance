import Foundation
import Testing
@testable import HermesKit

private struct VectorItem: Decodable { let amountCents: Int; let people: [String] }
private struct VectorInput: Decodable {
    let items: [VectorItem]
    let taxCents: Int, tipCents: Int, feesCents: Int, targetCents: Int
}
private struct VectorExpected: Decodable { let shares: [ItemShares.Share]; let gapCents: Int }
private struct VectorCase: Decodable {
    let name: String
    let input: VectorInput
    let expected: VectorExpected?
    let error: Bool?
}
private struct VectorFile: Decodable { let cases: [VectorCase] }

@Test func splitPickerAllowsAnySelectionWithAnotherPerson() {
    #expect(!DraftItem.canSplitAll(with: []))
    #expect(!DraftItem.canSplitAll(with: [ItemShares.me]))
    #expect(DraftItem.canSplitAll(with: ["person-1"]))
    #expect(DraftItem.canSplitAll(with: [ItemShares.me, "person-1"]))
    #expect(DraftItem.canSplitAll(with: ["person-1", "person-2"]))
}

@Test func splitAllReplacesPeopleAndPreservesItemDetails() {
    let original = [DraftItem(id: "item-1", name: "Synthetic Bagel", amountCents: 101, people: ["person-old"]),
                    DraftItem(id: "item-2", name: "Synthetic Discount", amountCents: -1, people: [ItemShares.me])]
    var items = original
    DraftItem.splitAll(&items, with: ["person-2", ItemShares.me, "person-1"])
    #expect(items.map(\.people) == [[ItemShares.me, "person-1", "person-2"], [ItemShares.me, "person-1", "person-2"]])
    #expect(items.map(\.id) == original.map(\.id))
    #expect(items.map(\.name) == original.map(\.name))
    #expect(items.map(\.amountCents) == original.map(\.amountCents))

    DraftItem.splitAll(&items, with: ["person-2", "person-1"])
    #expect(items.allSatisfy { $0.people == ["person-1", "person-2"] })

    DraftItem.splitAll(&items, with: [ItemShares.me, "person-1"])
    #expect(items.allSatisfy { $0.people == [ItemShares.me, "person-1"] })

    DraftItem.splitAll(&items, with: ["person-1"])
    #expect(items.allSatisfy { $0.people == ["person-1"] })
    let shares = ItemShares.compute(items: items.map { .init(amountCents: $0.amountCents, people: $0.people) },
                                   taxCents: 10, tipCents: 20, feesCents: 0, targetCents: 130)
    #expect(shares?.shares == [.init(person: "person-1", cents: 130)])
}

@Test func shareVectorsMatchTheServer() throws {
    let file = try JSONDecoder().decode(VectorFile.self, from: try fixture("item-shares"))
    #expect(file.cases.count >= 10)
    for c in file.cases {
        let result = ItemShares.compute(items: c.input.items.map { ItemShares.Item(amountCents: $0.amountCents, people: $0.people) },
                                        taxCents: c.input.taxCents, tipCents: c.input.tipCents, feesCents: c.input.feesCents, targetCents: c.input.targetCents)
        if c.error == true {
            #expect(result == nil, "\(c.name)")
        } else {
            let expected = try #require(c.expected, "\(c.name)")
            #expect(result?.shares == expected.shares && result?.gapCents == expected.gapCents, "\(c.name)")
        }
    }
}

@Test func overflowingAmountsGiveNilInsteadOfTrapping() {
    let huge = ItemShares.Item(amountCents: 10_000_000_000, people: ["me"])
    #expect(ItemShares.compute(items: [huge], taxCents: 0, tipCents: 0, feesCents: 0, targetCents: 10_000_000_000) == nil)
    #expect(ItemShares.compute(items: [.init(amountCents: Int.max, people: ["me"]), .init(amountCents: 1, people: ["me"])],
                               taxCents: 0, tipCents: 0, feesCents: 0, targetCents: 100) == nil)
    #expect(ItemShares.compute(items: [.init(amountCents: 100, people: ["me"])], taxCents: Int.max, tipCents: 1, feesCents: 0, targetCents: 100) == nil)
}

@Test func combinedParticipantsMustFitTheSplitEditor() {
    let people = (0..<20).map { "p\($0)" }
    let owner = ItemShares.Item(amountCents: 100, people: ["me"])
    #expect(ItemShares.compute(items: [.init(amountCents: 2000, people: people), owner],
                               taxCents: 0, tipCents: 0, feesCents: 0, targetCents: 2100) == nil)
    let valid = ItemShares.compute(items: [.init(amountCents: 2000, people: Array(people.prefix(19))), owner],
                                   taxCents: 0, tipCents: 0, feesCents: 0, targetCents: 2100)
    #expect(valid?.shares.count == 20)
    #expect(valid?.shares.reduce(0) { $0 + $1.cents } == 2100)
}

@Test func itemizationDecodes() throws {
    let it: Itemization = try JSONDecoder().decode(Itemization.self, from: try fixture("itemization"))
    #expect(it.items.map(\.name) == ["Synthetic Bagel", "Synthetic Coffee"])
    #expect(it.items[1].people == ["me", "person-1"])
    #expect(it.taxCents == 50 && it.readAt != nil && it.handEdited == false)
}

@Test func readReceiptPostsWithoutAKey() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("itemization")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    _ = try await client.readReceipt(transactionId: "t1")
    let request = try #require(transport.requests.first)
    #expect(request.method == "POST" && request.url.path() == "/v1/transactions/t1/receipt/read")
    #expect(request.headers["Idempotency-Key"] == nil && request.body == nil)
}

@Test func saveItemsPutsTheBodyWithAKey() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("transaction")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let body = SaveItemsBody(items: [.init(name: "A", amountCents: 100, people: ["me"])], taxCents: 1, tipCents: 0, feesCents: 0)
    _ = try await client.saveReceiptItems(transactionId: "t1", body: body, idempotencyKey: "k")
    let request = try #require(transport.requests.first)
    #expect(request.method == "PUT" && request.url.path() == "/v1/transactions/t1/receipt/items" && request.headers["Idempotency-Key"] == "k")
    let sent = try #require(request.body)
    let json = try #require(JSONSerialization.jsonObject(with: sent) as? [String: Any])
    #expect(json["taxCents"] as? Int == 1 && (json["items"] as? [[String: Any]])?.first?["people"] as? [String] == ["me"])
}
