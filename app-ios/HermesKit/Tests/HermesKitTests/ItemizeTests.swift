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
