import Testing
@testable import HermesKit

private func row(_ id: String, _ date: String = "2026-03-10", account: String = "a1", category: String? = nil,
                 person: String? = nil, payer: String? = nil, lines: [SplitLine] = []) -> LedgerTransaction {
    LedgerTransaction(id: id, accountId: account, source: "manual", date: date, amountCents: -500,
                      payee: "Synthetic Quill", bankDescription: "SYNTHETIC CARD PAYMENT", merchantName: nil,
                      pending: false, categoryId: category, notes: nil, splitLines: lines, personId: person,
                      paidByPersonId: payer, repaymentDismissed: nil, reconciled: nil, hasReceipt: nil,
                      forgiven: nil, hasHistory: nil, recurring: nil)
}

@Test func appendedPagesKeepExistingRowsAndDropRepeatedIDs() {
    let original = row("a", "2026-03-12")
    let moved = row("a", "2026-03-09")
    let rows = [original].appendingPage([moved, row("b"), row("b"), row("c")])
    #expect(rows.map(\.id) == ["a", "b", "c"])
    #expect(rows.first == original)
    #expect([LedgerTransaction]().appendingPage([original, original]) == [original])
}

@Test func historyPagesDedupeByRowIdentity() {
    let charge = PayeeHistoryRow(transactionId: "a", date: "2026-03-10", name: "Synthetic Quill",
                                shareCents: 500, totalCents: nil, upcoming: false, reimbursed: nil)
    #expect([charge].appendingPage([charge]).count == 1)
}

@Test func activityFiltersMatchAccountCategoryAndEveryPersonLocation() {
    #expect(TransactionQuery().matchesFilters(row("a")))
    #expect(TransactionQuery(accountId: "a1", categoryId: "c1", personId: "p1")
        .matchesFilters(row("a", category: "c1", payer: "p1")))
    #expect(!TransactionQuery(accountId: "a2").matchesFilters(row("a")))
    #expect(!TransactionQuery(categoryId: "c1").matchesFilters(row("a", category: "c2")))
    #expect(!TransactionQuery(personId: "p1").matchesFilters(row("a")))
    #expect(TransactionQuery(personId: "p1").matchesFilters(row("a", person: "p1")))
    let lines = [SplitLine(id: "l1", amountCents: -300, categoryId: "c1", notes: nil, personId: nil, payee: nil),
                 SplitLine(id: "l2", amountCents: -200, categoryId: nil, notes: nil, personId: "p1", payee: nil)]
    let split = row("a", lines: lines)
    #expect(TransactionQuery(categoryId: "c1", personId: "p1").matchesFilters(split))
    #expect(!TransactionQuery(categoryId: "c2", personId: "p1").matchesFilters(split))
    #expect(!TransactionQuery(categoryId: "c1", personId: "p2").matchesFilters(split))
}

@Test func dateEditsReinsertWithinLoadedWindowUsingDescendingIDForTies() {
    var rows = [row("z", "2026-03-12"), row("m", "2026-03-11"), row("a", "2026-03-10")]
    rows.refreshTransaction(row("a", "2026-03-11"))
    #expect(rows.map(\.id) == ["z", "m", "a"])
    rows.refreshTransaction(row("a", "2026-03-13"))
    #expect(rows.map(\.id) == ["a", "z", "m"])
    rows.refreshTransaction(row("z", "2026-03-11"))
    #expect(rows.map(\.id) == ["a", "z", "m"])
    rows.refreshTransaction(row("a", "2026-03-11"))
    #expect(rows.map(\.id) == ["z", "m"])
}

@Test func dateEditsBelowOldBoundaryDropWithoutReplacingLoadedPages() {
    var rows = [row("z", "2026-03-12"), row("m", "2026-03-11"), row("a", "2026-03-10")]
    rows.refreshTransaction(row("a", "2026-03-09"))
    #expect(rows.map(\.id) == ["z", "m"])
    rows.refreshTransaction(row("z", "2026-03-10"))
    #expect(rows.map(\.id) == ["m"])
    rows.refreshTransaction(row("m", "2026-03-10"))
    #expect(rows.isEmpty)
    rows.refreshTransaction(row("missing", "2026-03-13"))
    #expect(rows.isEmpty)
}

@Test func nonDateEditsReplaceInPlaceIncludingTheLastRow() {
    var rows = [row("z"), row("a")]
    let edited = row("a", category: "c2")
    rows.refreshTransaction(edited)
    #expect(rows == [row("z"), edited])
    rows.refreshTransaction(row("missing"))
    #expect(rows == [row("z"), edited])
}
