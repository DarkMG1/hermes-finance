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

@Test func renamingIrregularBillOmitsFrequencyUntilChanged() throws {
    var json = try #require(JSONSerialization.jsonObject(with: try itemJSON()) as? [String: Any])
    json["frequency"] = "unknown"
    let item = try JSONDecoder().decode(RecurringItem.self, from: JSONSerialization.data(withJSONObject: json))
    let untouched = PatchRecurringBody(item: item, name: item.name, frequency: item.frequency)
    #expect(untouched.name == nil && untouched.frequency == nil)
    let renamed = PatchRecurringBody(item: item, name: " Synthetic Wren ", frequency: item.frequency)
    let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(renamed)) as? [String: String])
    #expect(encoded == ["name": "Synthetic Wren"])
    let changed = PatchRecurringBody(item: item, name: item.name, frequency: "monthly")
    #expect(changed.name == nil && changed.frequency == "monthly")
}

@Test func endedDecodesAndIsSent() async throws {
    var json = try #require(JSONSerialization.jsonObject(with: try itemJSON()) as? [String: Any])
    json["ended"] = nil
    json["cancelled"] = nil
    json["stopped"] = nil
    let old = try JSONDecoder().decode(RecurringItem.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(old.ended == nil && old.cancelled == nil && old.stopped == nil)
    json["ended"] = true
    json["cancelled"] = false
    json["stopped"] = true
    let item = try JSONDecoder().decode(RecurringItem.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(item.ended == true && item.cancelled == false && item.stopped == true)
    let body = try JSONEncoder().encode(PatchRecurringBody(ended: false))
    #expect(String(bytes: body, encoding: .utf8) == #"{"ended":false}"#)
}

@Test func transactionRecurringDecodesOrIsAbsent() throws {
    var json = try #require(JSONSerialization.jsonObject(with: try fixture("transaction")) as? [String: Any])
    json["recurring"] = nil
    #expect(try JSONDecoder().decode(LedgerTransaction.self, from: JSONSerialization.data(withJSONObject: json)).recurring == nil)
    #expect(try JSONDecoder().decode(LedgerTransaction.self, from: try fixture("transaction-recurring")).recurring != nil)
    json["recurring"] = ["id": "r1", "name": "Synthetic Gym", "frequency": "monthly"]
    let transaction = try JSONDecoder().decode(LedgerTransaction.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(transaction.recurring == TransactionRecurring(id: "r1", name: "Synthetic Gym", frequency: "monthly"))
}

@Test func unconfirmedRecurringRenameRetainsPatchAfterHistoryRefresh() async throws {
    let item = try JSONDecoder().decode(RecurringItem.self, from: itemJSON())
    var json = try #require(JSONSerialization.jsonObject(with: itemJSON()) as? [String: Any])
    json["name"] = "Synthetic Wren"
    let response = try JSONSerialization.data(withJSONObject: json)
    let refreshed = try JSONDecoder().decode(RecurringItem.self, from: response)
    let transport = FakeTransport([.failure(URLError(.timedOut)), .success(HTTPResponse(status: 200, body: response))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    var write = PendingWrite<PatchRecurringBody>()
    let original = write.prepare(PatchRecurringBody(item: item, name: refreshed.name, frequency: item.frequency))
    let key = write.guardState.key
    do {
        _ = try await client.patchRecurring(id: item.id, body: original, idempotencyKey: key)
        Issue.record("Expected an unconfirmed rename")
    } catch {
        write.guardState.didFail(error)
    }
    let proposed = PatchRecurringBody(item: refreshed, name: refreshed.name, frequency: refreshed.frequency)
    #expect(proposed.name == nil && proposed.frequency == nil && write.guardState.unresolved)
    let retry = write.prepare(proposed)
    #expect(retry.name == "Synthetic Wren" && retry.frequency == nil && write.guardState.key == key)
    _ = try await client.patchRecurring(id: item.id, body: retry, idempotencyKey: write.guardState.key)
    write.guardState.didSucceed()
    #expect(!write.guardState.unresolved)
    #expect(transport.requests[0].body == transport.requests[1].body)
    #expect(transport.requests[0].headers["Idempotency-Key"] == transport.requests[1].headers["Idempotency-Key"])
}

@Test func onlyChargesWithAnOwnerPortionCanBeMarkedRecurring() throws {
    var json = try #require(JSONSerialization.jsonObject(with: fixture("transaction")) as? [String: Any])
    json["amountCents"] = -600
    json["personId"] = NSNull()
    json["forgiven"] = false
    json["splitLines"] = []
    func eligible() throws -> Bool {
        try JSONDecoder().decode(LedgerTransaction.self, from: JSONSerialization.data(withJSONObject: json)).canMarkRecurring
    }
    #expect(try eligible())
    json["personId"] = "p1"
    #expect(try !eligible())
    json["personId"] = NSNull()
    let theirs: [String: Any] = ["id": "s1", "amountCents": -300, "personId": "p1"]
    let alsoTheirs: [String: Any] = ["id": "s2", "amountCents": -300, "personId": "p2"]
    let mine: [String: Any] = ["id": "s2", "amountCents": -300]
    json["splitLines"] = [theirs, alsoTheirs]
    #expect(try !eligible())
    json["splitLines"] = [theirs, mine]
    #expect(try eligible())
    json["splitLines"] = [theirs, ["id": "s2", "amountCents": 0]]
    #expect(try !eligible())
    json["splitLines"] = [theirs, mine]
    json["forgiven"] = true
    #expect(try !eligible())
    json["forgiven"] = false
    json["splitLines"] = []
    json["paidByPersonId"] = "p1"
    #expect(try eligible())
    json["amountCents"] = 0
    #expect(try !eligible())
    json["amountCents"] = 600
    #expect(try !eligible())
}
