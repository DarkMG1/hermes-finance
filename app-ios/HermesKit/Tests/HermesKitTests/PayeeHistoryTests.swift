import Foundation
import Testing
@testable import HermesKit

@Test func payeeHistoryFixtureDecodes() throws {
    let history = try JSONDecoder().decode(PayeeHistory.self, from: try fixture("payee-history"))
    let row = try #require(history.rows.first)
    #expect(history.months.count == 12 && history.months.last?.month == "2026-03")
    #expect(row.id == "txn-3" && row.shareCents == 2500 && row.totalCents == 4000 && !row.upcoming)
    #expect(history.nextCursor == nil)
}

@Test func unsplitUpcomingRowDecodes() throws {
    let json = #"{"transactionId":"t","date":"2026-03-20","name":"Synthetic Deli","shareCents":1000,"totalCents":null,"upcoming":true,"reimbursed":true}"#
    let row = try JSONDecoder().decode(PayeeHistoryRow.self, from: Data(json.utf8))
    #expect(row.totalCents == nil && row.upcoming && row.reimbursed == true)
}

@Test func historyCachedBeforeReimbursedStillDecodes() throws {
    let json = #"{"transactionId":"t","date":"2026-03-20","name":"Synthetic Deli","shareCents":1000,"totalCents":null,"upcoming":false}"#
    #expect(try JSONDecoder().decode(PayeeHistoryRow.self, from: Data(json.utf8)).reimbursed == nil)
}

@Test func historyNamesDecodeOrAreAbsent() throws {
    #expect(try JSONDecoder().decode(PayeeHistory.self, from: try fixture("payee-history")).names == nil)
    var json = try #require(JSONSerialization.jsonObject(with: try fixture("payee-history")) as? [String: Any])
    json["names"] = [["name": "Acme Gas", "excluded": true]]
    let history = try JSONDecoder().decode(PayeeHistory.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(history.names?.first?.name == "Acme Gas" && history.names?.first?.excluded == true)
}

@Test func historyExclusionPutsTheState() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 204, body: Data()))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    try await client.putHistoryExclusion(name: "Acme", excludedName: "Acme Gas", excluded: true)
    let request = try #require(transport.requests.first)
    #expect(request.method == "PUT" && request.url.path() == "/v1/payee-history/exclusions" && request.headers["Idempotency-Key"] == nil)
    let body = try #require(request.body)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json["name"] as? String == "Acme" && json["excludedName"] as? String == "Acme Gas" && json["excluded"] as? Bool == true)
}

@Test func reimbursementsDecode() throws {
    let json = #"""
    {"months":[{"month":"2026-10","outCents":5000,"inCents":2000,"unpaidCents":3000}],
     "rows":[{"transactionId":"t","lineId":null,"date":"2026-10-02","name":"Synthetic Deli","amountCents":-5000},
             {"transactionId":"t","lineId":"l","date":"2026-10-02","name":"Synthetic Deli","amountCents":2000}]}
    """#
    let loaded = try JSONDecoder().decode(Reimbursements.self, from: Data(json.utf8))
    #expect(loaded.months.first?.unpaidCents == 3000 && loaded.rows.map(\.id) == ["t/", "t/l"] && loaded.rows[0].amountCents == -5000)
}
