import Foundation
import Testing
@testable import HermesKit

@Test func taxFixturesDecode() throws {
    let projection = try decode(TaxProjection.self, "tax-projection")
    #expect(projection.year == 2027 && projection.openYears == [2025, 2026, 2027] && projection.returns.first?.jurisdiction == "federal")
    #expect(projection.returns.first?.lines.first?.key == "wages" && projection.returns.first?.lines.first?.assumption != nil)
    let whatIf = try decode(TaxWhatIf.self, "tax-what-if")
    #expect(whatIf.before.year == 2026 && whatIf.after.year == 2026)
    let heads = try decode(TaxHeadsUp.self, "tax-heads-up")
    #expect(heads.count == 1 && heads.items?.first?.kind == "k401_room" && heads.items?.first?.dueDate == nil)
    let inputs = try decode(TaxInputs.self, "tax-inputs")
    #expect(inputs.year == 2026 && inputs.fields.studentLoanInterestCents == 50000 && inputs.fields.tuitionCents == nil)
    let scenario = try decode(TaxScenario.self, "tax-scenario")
    #expect(scenario.fields.moveTo == "XB" && scenario.fields.bonusCents == 1000000 && scenario.fields.rothCents == nil)
    let lots = try decode(TaxLots.self, "tax-lots")
    #expect(lots.lots.first?.status == "known" && lots.methods["acct-tax-brokerage"] == "fifo" && lots.inferred["acct-tax-brokerage"] == true)
    let years = try decode(TaxYears.self, "tax-years")
    #expect(years.years.first?.returns.first?.capitalLossCarryoverShortCents == 5000)
    #expect(years.years.first?.returns.first?.capitalLossCarryoverLongCents == 15000)
}

@Test func olderServerTaxPayloadsDecode() throws {
    var json = try #require(JSONSerialization.jsonObject(with: fixture("tax-projection")) as? [String: Any])
    json.removeValue(forKey: "headsUp")
    let old = try JSONDecoder().decode(TaxProjection.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(old.headsUp.isEmpty)
    var years = try #require(JSONSerialization.jsonObject(with: fixture("tax-years")) as? [String: Any])
    var year = try #require((years["years"] as? [[String: Any]])?.first)
    var ret = try #require((year["returns"] as? [[String: Any]])?.first)
    ret.removeValue(forKey: "capitalLossCarryoverShortCents")
    ret.removeValue(forKey: "capitalLossCarryoverLongCents")
    year["returns"] = [ret]
    years["years"] = [year]
    let decoded = try JSONDecoder().decode(TaxYears.self, from: JSONSerialization.data(withJSONObject: years))
    #expect(decoded.years.first?.returns.first?.capitalLossCarryoverShortCents == nil)
}

private func client(_ transport: FakeTransport) -> APIClient { APIClient(baseURL: testBase, token: "t", transport: transport) }
private func ok(_ name: String, status: Int = 200) throws -> Result<HTTPResponse, Error> { .success(HTTPResponse(status: status, body: try fixture(name))) }
private func json(_ data: Data?) throws -> [String: JSONValue] { try JSONDecoder().decode([String: JSONValue].self, from: try #require(data)) }

@Test func taxReadsUseTheRightPathsAndQueries() async throws {
    let transport = FakeTransport([try ok("tax-projection"), try ok("tax-heads-up"), try ok("tax-heads-up"),
        try ok("tax-inputs"), try ok("tax-scenario"), try ok("tax-lots")])
    let c = client(transport)
    _ = try await c.taxProjection(year: 2027)
    _ = try await c.taxHeadsUp(unlocked: true)
    _ = try await c.taxHeadsUp(unlocked: false)
    _ = try await c.taxInputs(year: 2026)
    _ = try await c.taxScenario(year: 2027)
    _ = try await c.taxLots()
    let r = transport.requests
    #expect(r.map(\.method) == Array(repeating: "GET", count: 6))
    #expect(r.map { $0.url.path } == ["/v1/tax/projection", "/v1/tax/heads-up", "/v1/tax/heads-up",
        "/v1/tax/inputs/2026", "/v1/tax/scenario/2027", "/v1/tax/lots"])
    #expect(r[0].url.query == "year=2027" && r[1].url.query == "unlocked=1" && r[2].url.query == nil)
}

@Test func taxWritesSendTheRightBodies() async throws {
    let roth = Data(#"{"id":"r1","date":"2026-02-01","amountCents":50000,"taxYear":2025,"transactionId":null}"#.utf8)
    let transport = FakeTransport([try ok("tax-what-if"), try ok("tax-inputs"), try ok("tax-scenario"),
        .success(HTTPResponse(status: 201, body: roth)), .success(HTTPResponse(status: 200, body: roth)),
        .success(HTTPResponse(status: 200, body: Data(#"{"ok":true}"#.utf8))), .success(HTTPResponse(status: 201, body: Data(#"{"id":"l1"}"#.utf8))),
        .success(HTTPResponse(status: 200, body: Data(#"{"ok":true}"#.utf8))), .success(HTTPResponse(status: 200, body: Data(#"{}"#.utf8))),
        .success(HTTPResponse(status: 200, body: Data(#"{}"#.utf8))), .success(HTTPResponse(status: 200, body: Data(#"{"contributions":[]}"#.utf8)))])
    let c = client(transport)
    _ = try await c.taxWhatIf(year: 2026, change: TaxWhatIfChange(
        sell: [TaxWhatIfSale(accountId: "a", securityId: "s", quantity: 2)], extraWithholdingCents: 100))
    var inputs = TaxInputsBody(); inputs.k401Cents = 5
    _ = try await c.putTaxInputs(year: 2026, inputs, idempotencyKey: "k8")
    var scenario = TaxScenarioBody(); scenario.bonusCents = 7
    _ = try await c.putTaxScenario(year: 2027, scenario, idempotencyKey: "k9")
    let added = try await c.addRothContribution(RothContributionBody(date: "2026-02-01", amountCents: 50000, taxYear: 2025), idempotencyKey: "k1")
    #expect(added.id == "r1" && added.transactionId == nil)
    _ = try await c.setRothContributionYear(id: "r1", taxYear: 2026, idempotencyKey: "k2")
    try await c.deleteRothContribution(id: "r1", idempotencyKey: "k3")
    try await c.addTaxLot(TaxLotBody(accountId: "a", securityId: "s", acquiredOn: "2020-01-02", quantity: 1.5, costCents: 900), idempotencyKey: "k4")
    try await c.deleteTaxLot(id: "l1", idempotencyKey: "k5")
    try await c.setLotMethod(accountId: "a", method: "hifo", idempotencyKey: "k6")
    try await c.setLotMethod(accountId: "a", method: nil, idempotencyKey: "k7")
    #expect(try await c.rothContributions(taxYear: 2025).isEmpty)
    let r = transport.requests
    #expect(r.map(\.method) == ["POST", "PUT", "PUT", "POST", "PUT", "DELETE", "POST", "DELETE", "PATCH", "PATCH", "GET"])
    #expect(r.map { $0.url.path } == ["/v1/tax/what-if", "/v1/tax/inputs/2026", "/v1/tax/scenario/2027",
        "/v1/tax/roth-contributions", "/v1/tax/roth-contributions/r1",
        "/v1/tax/roth-contributions/r1", "/v1/tax/lots", "/v1/tax/lots/l1", "/v1/accounts/a/lot-method",
        "/v1/accounts/a/lot-method", "/v1/tax/roth-contributions"])
    #expect(r[10].url.query == "taxYear=2025")
    #expect(try json(r[0].body) == ["year": .number(2026), "change": .object(["sell": .array([.object(["accountId": .string("a"), "securityId": .string("s"),
        "quantity": .number(2)])]),
        "extraWithholdingCents": .number(100)])])
    #expect(try json(r[1].body) == ["k401Cents": .number(5)])
    #expect(try json(r[2].body) == ["bonusCents": .number(7)])
    #expect(try json(r[4].body) == ["taxYear": .number(2026)] && r[5].body == nil)
    #expect(try json(r[6].body)["quantity"] == .number(1.5))
    #expect(try json(r[8].body) == ["method": .string("hifo")])
    #expect(try json(r[9].body) == ["method": .null])
    #expect(r.map { $0.headers["Idempotency-Key"] } == [nil, "k8", "k9", "k1", "k2", "k3", "k4", "k5", "k6", "k7", nil])
}

@Test func olderServerReturnWithoutSafeHarborOrCarryoverDecodes() throws {
    var json = try #require(JSONSerialization.jsonObject(with: fixture("tax-projection")) as? [String: Any])
    var returns = try #require(json["returns"] as? [[String: Any]])
    returns[0].removeValue(forKey: "safeHarborCents")
    returns[0].removeValue(forKey: "unusedCarryover")
    json["returns"] = returns
    let old = try JSONDecoder().decode(TaxProjection.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(old.returns[0].safeHarborCents == nil && old.returns[0].unusedCarryover == nil)
}
