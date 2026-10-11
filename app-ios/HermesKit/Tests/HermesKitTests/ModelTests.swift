import Foundation
import Testing
@testable import HermesKit
@testable import struct HermesKit.Category

func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try JSONDecoder().decode(T.self, from: fixture(name))
}

func json(_ value: some Encodable) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return try #require(String(data: encoder.encode(value), encoding: .utf8))
}

@Test func everyFixtureDecodes() throws {
    let health = try decode(Health.self, "health")
    #expect(health.ok && health.dbVersion >= 3)
    let home = try decode(Home.self, "home")
    #expect(home.recent.count == 6 && home.owedToYouCents == 200 && home.youOweCents == 0 && home.repaymentSuggestions == 1)
    #expect(home.reconnect.map(\.institutionName) == ["Synthetic Credit Union"])
    let accounts = try decode([Account].self, "accounts")
    #expect(accounts.count == 3)
    let categories = try decode([Category].self, "categories")
    #expect(categories.contains { $0.isIncome })
    let page = try decode(TransactionPage.self, "transactions-page")
    #expect(page.transactions.count == 2 && page.nextCursor != nil)
    let split = try decode(LedgerTransaction.self, "transaction")
    #expect(split.splitLines.map(\.amountCents) == [-2500, -1500])
    #expect(split.pending && split.source == "manual")
    let spending = try decode(Spending.self, "spending")
    #expect(spending.outCents > 0 && spending.inCents > 0 && spending.netCents == spending.inCents - spending.outCents)
    #expect(split.splitLines.first?.payee == "Synthetic Lamp" && split.splitLines.last?.payee == nil)
    let expenses = try decode(ExpensesPage.self, "expenses")
    #expect(expenses.rows.map(\.name) == ["Synthetic Cafe", "Synthetic Lamp", "Synthetic Market"])
    #expect(expenses.rows[1].isSplit && expenses.rows[1].lineId == "line-1" && !expenses.rows[1].isSplitDifference)
    #expect(Set(expenses.rows.map(\.id)).count == expenses.rows.count)
    let banks = try decode([Bank].self, "banks")
    #expect(banks.contains { $0.status == "login_required" })
    #expect(try decode(SyncStatus.self, "sync-status").items.first?.added == 2)
    #expect(try decode(LinkSession.self, "link-session").sessionId == "fixture-session")
    #expect(try decode(Bank.self, "link-complete").status == "ok")
    #expect(try decode(AppleCardImportResult.self, "apple-card-import").added == 1)
    #expect(try decode(APIErrorBody.self, "error-not-found").code == "NOT_FOUND")
}

@Test func patchBodyEncodesOnlyChangedFieldsAndNullsForClears() throws {
    let body = PatchTransactionBody(categoryId: .set(nil), payee: .set("Synthetic"), notes: .unchanged)
    #expect(try json(body) == #"{"categoryId":null,"payee":"Synthetic"}"#)
}

@Test func accountRenameSendsNullToGoBackToTheBankName() throws {
    #expect(try json(PatchAccountBody(name: "Synthetic Card")) == #"{"name":"Synthetic Card"}"#)
    #expect(try json(PatchAccountBody(name: nil)) == #"{"name":null}"#)
}

@Test func splitsBodySendsNullCategoriesAndOmitsEmptyNotes() throws {
    let body = PutSplitsBody(lines: [.init(amountCents: -1245, categoryId: nil, notes: nil), .init(amountCents: -1245, categoryId: "c1", notes: "n")])
    #expect(try json(body) == #"{"lines":[{"amountCents":-1245,"categoryId":null},{"amountCents":-1245,"categoryId":"c1","notes":"n"}]}"#)
}

@Test func linkSessionBodyMatchesTheServerUnion() throws {
    #expect(try json(LinkSessionBody.create) == #"{"mode":"create"}"#)
    #expect(try json(LinkSessionBody.update(itemId: "i1")) == #"{"itemId":"i1","mode":"update"}"#)
}

@Test func createBodyOmitsNilOptionals() throws {
    let body = CreateTransactionBody(date: "2026-03-01", amountCents: -500, payee: "Synthetic", categoryId: nil, notes: nil)
    #expect(try json(body) == #"{"amountCents":-500,"date":"2026-03-01","payee":"Synthetic"}"#)
}

@Test func peopleFixturesDecode() throws {
    let people = try decode([Person].self, "people")
    #expect(people.first?.name == "Synthetic Quill" && people.first?.balanceCents == 200)
    let detail = try decode(PersonDetail.self, "person")
    #expect(detail.person.balanceCents == 200 && detail.history.map(\.kind) == ["forThem", "fromThem", "paidByThem"])
    #expect(detail.history.first?.lineId == "line-2" && detail.history.first?.balanceAfterCents == 200 && detail.history.last?.effectCents == -300)
    let suggestions = try decode([RepaymentSuggestion].self, "people-suggestions")
    #expect(suggestions.map(\.id) == ["txn-5"] && suggestions.first?.personId == "person-1")
    let split = try decode(LedgerTransaction.self, "transaction")
    #expect(split.splitLines.map(\.personId) == [nil, "person-1"] && split.personId == nil)
}

@Test func homeCachedByAnOlderBuildStillDecodes() throws {
    let old = #"{"netWorthCents":1,"recent":[],"reconnect":[]}"#
    let home = try JSONDecoder().decode(Home.self, from: Data(old.utf8))
    #expect(home.owedToYouCents == 0 && home.youOweCents == 0 && home.repaymentSuggestions == 0)
}

@Test func peopleSettingsSendsNullToClear() throws {
    #expect(try json(PeopleSettings(repaymentAccountId: nil)) == #"{"repaymentAccountId":null}"#)
    #expect(try json(PeopleSettings(repaymentAccountId: "a1")) == #"{"repaymentAccountId":"a1"}"#)
}

@Test func personBodiesEncode() throws {
    #expect(try json(PatchTransactionBody(personId: .set("p1"))) == #"{"personId":"p1"}"#)
    #expect(try json(PatchTransactionBody(personId: .set(nil))) == #"{"personId":null}"#)
    #expect(PatchTransactionBody(personId: .set("p1")).isEmpty == false)
    #expect(try json(PatchPersonBody(matchText: .set(nil))) == #"{"matchText":null}"#)
    #expect(try json(PatchPersonBody(name: "Synthetic Quill", archived: true)) == #"{"archived":true,"name":"Synthetic Quill"}"#)
    #expect(try json(CreatePersonBody(name: "Synthetic Quill", matchText: nil)) == #"{"name":"Synthetic Quill"}"#)
    let withPerson = SplitLineBody(amountCents: -500, categoryId: nil, notes: nil, personId: "p1")
    #expect(try json(withPerson) == #"{"amountCents":-500,"categoryId":null,"personId":"p1"}"#)
    #expect(try json(SplitLineBody(amountCents: -500, categoryId: "c", notes: nil)) == #"{"amountCents":-500,"categoryId":"c"}"#)
}

@Test func transactionCachedByAnOlderBuildStillDecodes() throws {
    let old = #"{"id":"t","accountId":"a","source":"manual","date":"2026-03-01","amountCents":-100,"payee":"P","bankDescription":"","#
        + #""merchantName":null,"pending":false,"categoryId":null,"notes":null,"splitLines":[]}"#
    let transaction = try JSONDecoder().decode(LedgerTransaction.self, from: Data(old.utf8))
    #expect(transaction.paidByPersonId == nil && transaction.repaymentDismissed == nil && transaction.personId == nil)
}

@Test func sharedCostGivesTheOwnerTheOddCent() {
    #expect(SharedCost.yourShare(totalCents: 10000, justMineCents: 2000) == 6000)
    #expect(SharedCost.yourShare(totalCents: 101, justMineCents: 0) == 51)
    #expect(SharedCost.yourShare(totalCents: 100, justMineCents: 100) == 100)
    #expect(SharedCost.yourShare(totalCents: 0, justMineCents: 0) == nil)
    #expect(SharedCost.yourShare(totalCents: 100, justMineCents: 101) == nil)
    #expect(SharedCost.yourShare(totalCents: 100, justMineCents: -1) == nil)
}

@Test func balancePhrases() {
    #expect(Balance.phrase(500) == "Owes you $5.00")
    #expect(Balance.phrase(-1250) == "You owe $12.50")
    #expect(Balance.phrase(0) == "Settled up")
}

@Test func sharedBalanceBodiesEncode() throws {
    #expect(try json(PatchTransactionBody(paidByPersonId: .set("p1"))) == #"{"paidByPersonId":"p1"}"#)
    #expect(try json(PatchTransactionBody(personId: .set(nil), paidByPersonId: .set("p1"))) == #"{"paidByPersonId":"p1","personId":null}"#)
    #expect(try json(PatchTransactionBody(repaymentDismissed: false)) == #"{"repaymentDismissed":false}"#)
    #expect(PatchTransactionBody(repaymentDismissed: false).isEmpty == false)
    #expect(try json(PatchTransactionBody(date: "2026-04-01")) == #"{"date":"2026-04-01"}"#)
    #expect(PatchTransactionBody(date: "2026-04-01").isEmpty == false)
    let paid = CreateTransactionBody(date: "2026-03-03", amountCents: -6000, payee: "M", categoryId: nil, notes: nil, paidByPersonId: "p1")
    #expect(try json(paid) == #"{"amountCents":-6000,"date":"2026-03-03","paidByPersonId":"p1","payee":"M"}"#)
}

@Test func createBodyCarriesSplitLines() throws {
    let body = CreateTransactionBody(date: "2026-03-05", amountCents: -4000, payee: "Synthetic Cash", categoryId: nil, notes: nil,
                                     splitLines: [SplitLineBody(amountCents: -2000, categoryId: "c1", notes: nil),
                                                  SplitLineBody(amountCents: -2000, categoryId: nil, notes: nil, personId: "p1")])
    #expect(try json(body) == #"{"amountCents":-4000,"date":"2026-03-05","payee":"Synthetic Cash","splitLines":"#
        + #"[{"amountCents":-2000,"categoryId":"c1"},{"amountCents":-2000,"categoryId":null,"personId":"p1"}]}"#)
}

@Test func spendingFromAnOlderServerDecodesOutFromTotal() throws {
    let data = Data(#"{"from":"2026-03-01","toExclusive":"2026-04-01","totalCents":700,"categories":[]}"#.utf8)
    let spending = try JSONDecoder().decode(Spending.self, from: data)
    #expect(spending.outCents == 700 && spending.inCents == 0 && spending.netCents == -700)
}

@Test func splitLineBodiesEncodeNames() throws {
    #expect(try json(SplitLineBody(amountCents: -500, categoryId: nil, notes: nil, payee: "Synthetic Lamp"))
        == #"{"amountCents":-500,"categoryId":null,"payee":"Synthetic Lamp"}"#)
    #expect(try json(SplitLineBody(amountCents: -500, categoryId: "c", notes: nil)) == #"{"amountCents":-500,"categoryId":"c"}"#)
    #expect(try json(PatchSplitLineBody(payee: .set(nil))) == #"{"payee":null}"#)
    #expect(try json(PatchSplitLineBody(categoryId: .set("c"), notes: .set("n"))) == #"{"categoryId":"c","notes":"n"}"#)
    #expect(PatchSplitLineBody().isEmpty && !PatchSplitLineBody(personId: .set("p")).isEmpty)
}

@Test func netWorthDecodesAndComputesPercent() throws {
    let history = try decode(NetWorthHistory.self, "net-worth")
    #expect(history.points.map(\.date) == ["2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"])
    #expect(history.currentCents == 245800 && history.changeCents == 149550)
    #expect(history.estimatedThrough == "2026-03-13")
    #expect(abs((history.changePercent ?? 0) - 149550.0 / 96250.0) < 0.000001)
    let body = #"{"points":[{"date":"2026-03-14","netWorthCents":0},{"date":"2026-03-15","netWorthCents":500}],"#
        + #""currentCents":500,"changeCents":500,"estimatedThrough":null}"#
    let fromZero = try JSONDecoder().decode(NetWorthHistory.self, from: Data(body.utf8))
    #expect(fromZero.changePercent == nil)
    #expect(fromZero.estimatedThrough == nil)
}

@Test func netWorthRangeQuery() {
    #expect(NetWorthRange.allCases.map(\.rawValue) == ["1m", "3m", "1y", "all"])
    #expect(NetWorthRange.allCases.map(\.title) == ["1M", "3M", "1Y", "All"])
    #expect(NetWorthRange.quarter.queryItems == [URLQueryItem(name: "range", value: "3m")])
}

@Test func investmentsDecode() throws {
    let investments = try decode(Investments.self, "investments")
    #expect(investments.totalCents == 200000 && investments.costBasisCents == 180000 && investments.gainCents == 20000)
    #expect(investments.holdings.map(\.key) == ["SYNA", "_cash"])
    let fund = try #require(investments.holdings.first)
    #expect(fund.quantity == 3 && fund.priceCents == 50000 && fund.gainCents == 20000)
    #expect(fund.accounts.map(\.accountId) == ["acct-brokerage", "acct-retirement"])
    #expect(abs((fund.gainPercent ?? 0) - 20000.0 / 130000.0) < 0.000001)
    #expect(investments.holdings[1].priceCents == nil && investments.holdings[1].ticker == nil && investments.holdings[1].isCash && !fund.isCash)
    #expect(abs((investments.gainPercent ?? 0) - 20000.0 / 180000.0) < 0.000001)
    #expect(fund.historyQuery == [URLQueryItem(name: "key", value: "SYNA")])
    let history = try decode(NetWorthHistory.self, "investments-history")
    #expect(history.points.map(\.netWorthCents) == [190000, 200000])
    let holding = try decode(NetWorthHistory.self, "holding-history")
    #expect(holding.changeCents == 7000 && holding.estimatedThrough == nil)
}
