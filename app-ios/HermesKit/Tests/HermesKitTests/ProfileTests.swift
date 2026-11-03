import Foundation
import Testing
@testable import HermesKit

@Test func profileFixturesDecode() throws {
    let profile = try decode(Profile.self, "profile")
    #expect(profile.state == "CA" && profile.hsa == true && profile.note == nil && profile.retirementPct == 6)
    let job = try decode(JobDetail.self, "job")
    #expect(job.employer == "SYNTHETIC EMPLOYER" && job.status == "current" && job.endDate == nil)
    #expect(job.grants.first?.shares == 400 && job.nextVests.map(\.shares) == [100, 25, 25, 25])
    #expect(job.stubs.first?.transactionIds == ["txn-2"] && job.stubs.first?.otherPayCents == 0 && job.forms.first?.kind == "w2")
    let jobless = try decode([PayStub].self, "pay-stubs-unassigned")
    #expect(jobless.map(\.id) == ["stub-2"] && jobless[0].jobId == nil && jobless[0].otherPayCents == 2500 && jobless[0].transactionIds.isEmpty)
    let matches = try decode(PayStubMatches.self, "pay-stub-matches")
    #expect(matches.deposits.first?.id == "txn-2" && matches.suggestions == [["txn-2"]])
    let years = try decode(TaxYears.self, "tax-years")
    #expect(years.years.first?.effectiveRate == 0.0997 && years.years.first?.returns.first?.jurisdiction == "federal")
    let linked = try decode(LedgerTransaction.self, "transaction-pay-stub")
    #expect(linked.payStub?.id == job.stubs.first?.id)
    #expect(try decode(LedgerTransaction.self, "transaction").payStub == nil)
}

@Test func olderServerTransactionWithoutPayStubDecodes() throws {
    var json = try #require(JSONSerialization.jsonObject(with: fixture("transaction-pay-stub")) as? [String: Any])
    json.removeValue(forKey: "payStub")
    let old = try JSONDecoder().decode(LedgerTransaction.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(old.payStub == nil)
}

@Test func readDraftsDecodePerKind() throws {
    let ret = try decode(ProfileReadResult.self, "profile-read-tax-return")
    guard case .taxReturn(let r) = ret.draft else { Issue.record("not a tax return"); return }
    #expect(r.year == 2025 && r.jurisdiction == "federal" && r.agiCents == nil && ret.uncertain == ["agiCents"])
    guard case .taxForm(let f) = try decode(ProfileReadResult.self, "profile-read-tax-form").draft else { Issue.record("not a form"); return }
    #expect(f.payer == "SYNTHETIC EMPLOYER" && f.jobId == nil && f.stateWithheldCents == nil)
    guard case .payStub(let s, let employer) = try decode(ProfileReadResult.self, "profile-read-pay-stub").draft else { Issue.record("not a stub"); return }
    #expect(s.netCents == 370000 && s.stateCents == nil && employer == "SYNTHETIC EMPLOYER")
    guard case .offer(let j, let grants) = try decode(ProfileReadResult.self, "profile-read-offer").draft else { Issue.record("not an offer"); return }
    #expect(j.employer == "SYNTHETIC EMPLOYER" && j.status == nil && grants.first?.vestMonths == 48)
    // a draft with every field missing still decodes
    let empty = try JSONDecoder().decode(ProfileReadResult.self, from: Data(#"{"kind":"offer","draft":{}}"#.utf8))
    guard case .offer(let e, let none) = empty.draft else { Issue.record("not an offer"); return }
    #expect(e.employer == nil && none.isEmpty && empty.uncertain.isEmpty)
}

@Test func readSendsPagesAsBase64WithALongTimeout() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("profile-read-tax-form")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let result = try await client.readProfileDocument(kind: .taxForm, pages: [Data([0xff, 0xd8]), Data([0xff, 0xd9])])
    #expect(result.kind == .taxForm)
    let request = try #require(transport.requests.first)
    #expect(request.method == "POST" && request.url.path == "/v1/profile/read" && request.timeout == 120 && request.headers["Idempotency-Key"] == nil)
    let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(request.body))
    #expect(body == ["kind": .string("tax_form"), "pages": .array([.string("/9g="), .string("/9k=")])])
}

@Test func createsOmitNilAndPatchesSendOnlyWhatChanged() async throws {
    let reply = try fixture("job")
    let transport = FakeTransport([.success(HTTPResponse(status: 201, body: reply)), .success(HTTPResponse(status: 200, body: reply))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    var job = CreateJobBody()
    job.employer = "SYNTHETIC EMPLOYER"
    job.status = "offered"
    job.note = "Synthetic"
    _ = try await client.createJob(job, idempotencyKey: "k-1")
    var edited = job
    edited.note = nil
    edited.baseCents = 100
    _ = try await client.patchJob(id: "job-1", body: edited, from: job, idempotencyKey: "k-2")
    let bodies = transport.requests.map { String(data: $0.body ?? Data(), encoding: .utf8) }
    #expect(bodies == [#"{"employer":"SYNTHETIC EMPLOYER","note":"Synthetic","status":"offered"}"#, #"{"baseCents":100,"note":null}"#])
    #expect(transport.requests.map(\.method) == ["POST", "PATCH"] && transport.requests.map { $0.headers["Idempotency-Key"] } == ["k-1", "k-2"])
    #expect(transport.requests.last?.url.path == "/v1/jobs/job-1")
}

@Test func linkPayStubSendsTheDepositsAndAnEmptyListToUnlink() async throws {
    let stub = try JSONSerialization.data(withJSONObject: try #require(
        JSONSerialization.jsonObject(with: fixture("job")) as? [String: Any])["stubs"].flatMap { ($0 as? [Any])?.first } as Any)
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: stub)), .success(HTTPResponse(status: 200, body: stub))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    _ = try await client.linkPayStub(id: "stub-1", transactionIds: ["txn-2", "txn-3"], idempotencyKey: "k-1")
    _ = try await client.linkPayStub(id: "stub-1", transactionIds: [], idempotencyKey: "k-2")
    #expect(transport.requests.map { String(data: $0.body ?? Data(), encoding: .utf8) }
        == [#"{"transactionIds":["txn-2","txn-3"]}"#, #"{"transactionIds":[]}"#])
    #expect(transport.requests.map(\.url.path) == ["/v1/pay-stubs/stub-1/link", "/v1/pay-stubs/stub-1/link"])
}

@Test func clearingAPayStubLineOrACliffSendsNull() async throws {
    let replies = try JSONSerialization.jsonObject(with: fixture("job")) as? [String: Any]
    let stub = try JSONSerialization.data(withJSONObject: try #require((replies?["stubs"] as? [Any])?.first))
    let grant = try JSONSerialization.data(withJSONObject: try #require((replies?["grants"] as? [Any])?.first))
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: stub)), .success(HTTPResponse(status: 200, body: grant))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let saved = try decode(JobDetail.self, "job")
    var s = saved.stubs[0].fields
    s.federalCents = nil
    s.netCents = 350000
    _ = try await client.patchPayStub(id: "stub-1", body: s, from: saved.stubs[0].fields, idempotencyKey: "k-1")
    var g = saved.grants[0].fields
    g.cliffMonths = nil
    _ = try await client.patchGrant(jobId: "job-1", id: "grant-1", body: g, from: saved.grants[0].fields, idempotencyKey: "k-2")
    let bodies = transport.requests.map { String(data: $0.body ?? Data(), encoding: .utf8) }
    #expect(bodies == [#"{"federalCents":null,"netCents":350000}"#, #"{"cliffMonths":null}"#])
    #expect(transport.requests.map(\.method) == ["PATCH", "PATCH"])
    #expect(transport.requests.map(\.url.path) == ["/v1/pay-stubs/stub-1", "/v1/jobs/job-1/grants/grant-1"])
}

@Test func aMergeEditKeepsWhatIsUnchangedAndSendsNullForWhatWasCleared() async throws {
    let reply = try fixture("profile")
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: reply))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let saved = try decode(Profile.self, "profile")
    var edited = saved
    edited.state = nil
    edited.dependents = 2
    _ = try await client.putProfile(edited, from: saved, idempotencyKey: "k-1")
    let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(transport.requests.first?.body))
    #expect(body["state"] == .null && body["dependents"] == .number(2) && body["filingStatus"] == .string("single") && body["hsa"] == .bool(true))
    #expect(body["note"] == nil, "a field empty before and after is left to the server's merge")
}

@Test func aReadTaxReturnReplacesTheSavedOneSoBlankFieldsGoOutAsNull() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: Data(#"{"id":"r","year":2025,"jurisdiction":"federal"}"#.utf8)))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    var read = TaxReturnBody()
    read.year = 2025
    read.jurisdiction = "federal"
    read.totalTaxCents = 650000
    _ = try await client.putTaxReturn(read, from: nil, idempotencyKey: "k-1")
    let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(transport.requests.first?.body))
    #expect(body["totalTaxCents"] == .number(650000) && body["year"] == .number(2025))
    #expect(body["capitalGainsCents"] == .null && body["creditsCents"] == .null && body.count == 15, "every field of the return is sent")
}

@Test func aStubBalancesWithinACentCountingOtherPay() {
    var s = PayStubBody()
    #expect(s.imbalanceCents == nil && s.balanceProblem == nil)
    s.grossCents = 400000
    s.federalCents = 50000
    s.otherDeductionsCents = 10000
    s.otherPayCents = 5000
    s.netCents = 345000
    #expect(s.imbalanceCents == 0 && s.balanceProblem == nil)
    s.netCents = 344999
    #expect(s.imbalanceCents == 1 && s.balanceProblem == nil, "a cent off is allowed, as on the server")
    s.netCents = 340000
    #expect(s.imbalanceCents == 5000 && s.balanceProblem?.hasPrefix("Off by $50.00") == true)
    s.netCents = 345000
    s.ytdGrossCents = 399999
    #expect(s.balanceProblem == "Gross year to date is less than gross pay")
}

@Test func hasProfileProbesWithoutLoadingTheProfile() async throws {
    let transport = FakeTransport([FakeTransport.json(200, #"{"ok":true}"#), FakeTransport.json(404, #"{"code":"NOT_FOUND","message":"x"}"#)])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    #expect(try await client.hasProfile())
    #expect(try await !client.hasProfile(), "an older server")
    #expect(transport.requests.map(\.url.path) == ["/v1/profile/exists", "/v1/profile/exists"])
}

@Test func unassignedStubsComeFromTheirOwnRoute() async throws {
    let transport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("pay-stubs-unassigned")))])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    #expect(try await client.unassignedPayStubs().map(\.id) == ["stub-2"])
    #expect(transport.requests.first?.url.path == "/v1/pay-stubs/unassigned")
}
