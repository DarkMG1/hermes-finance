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
    #expect(home.recent.count == 3)
    #expect(home.reconnect.map(\.institutionName) == ["Synthetic Credit Union"])
    let accounts = try decode([Account].self, "accounts")
    #expect(accounts.count == 2)
    let categories = try decode([Category].self, "categories")
    #expect(categories.contains { $0.isIncome })
    let page = try decode(TransactionPage.self, "transactions-page")
    #expect(page.transactions.count == 2 && page.nextCursor != nil)
    let split = try decode(LedgerTransaction.self, "transaction")
    #expect(split.splitLines.map(\.amountCents) == [-2500, -1500])
    #expect(split.pending && split.source == "manual")
    #expect(try decode(Spending.self, "spending").totalCents > 0)
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

@Test func linkSessionBodyMatchesTheServerUnion() throws {
    #expect(try json(LinkSessionBody.create) == #"{"mode":"create"}"#)
    #expect(try json(LinkSessionBody.update(itemId: "i1")) == #"{"itemId":"i1","mode":"update"}"#)
}

@Test func createBodyOmitsNilOptionals() throws {
    let body = CreateTransactionBody(accountId: "a1", date: "2026-03-01", amountCents: -500, payee: "Synthetic", categoryId: nil, notes: nil)
    #expect(try json(body) == #"{"accountId":"a1","amountCents":-500,"date":"2026-03-01","payee":"Synthetic"}"#)
}
