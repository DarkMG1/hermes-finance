import Testing
@testable import HermesKit

private func labelTransaction(amount: Int = -1000, pending: Bool = false, person: String? = nil, payer: String? = nil,
                              lines: [SplitLine] = [], forgiven: Bool? = nil, reconciled: Bool? = nil,
                              recurring: TransactionRecurring? = nil) -> LedgerTransaction {
    LedgerTransaction(id: "t1", accountId: "a1", source: "manual", date: "2026-03-10", amountCents: amount,
                      payee: "Synthetic Grocer", bankDescription: "SYNTHETIC CARD PAYMENT", merchantName: nil,
                      pending: pending, categoryId: nil, notes: nil, splitLines: lines, personId: person,
                      paidByPersonId: payer, repaymentDismissed: nil, reconciled: reconciled, hasReceipt: nil,
                      forgiven: forgiven, hasHistory: nil, recurring: recurring)
}

private func labelLine(_ amount: Int, person: String? = nil, category: String? = nil) -> SplitLine {
    SplitLine(id: "l1", amountCents: amount, categoryId: category, notes: nil, personId: person, payee: nil)
}

private func subtitle(_ transaction: LedgerTransaction, category: String = "Uncategorized") -> String {
    TransactionLabel.subtitle(transaction, day: "Today", categoryName: category,
                              personName: { $0 == "p1" ? "Synthetic Quill" : "Synthetic Wren" })
}

@Test func transactionTagsNameWhoOwesOrRepaid() {
    #expect(TransactionLabel.tag(personName: "Synthetic Quill", categoryName: "Synthetic Food", amountCents: -100) == "Synthetic Quill owes")
    #expect(TransactionLabel.tag(personName: "Synthetic Quill", categoryName: "Synthetic Food", amountCents: 100) == "Synthetic Quill repaid")
    #expect(TransactionLabel.tag(personName: nil, categoryName: "Synthetic Food", amountCents: -100) == "Synthetic Food")
    #expect(subtitle(labelTransaction(person: "p1")) == "Today · Synthetic Quill owes")
    #expect(subtitle(labelTransaction(amount: 1000, person: "p1")) == "Today · Synthetic Quill repaid")
}

@Test func transactionSubtitlePutsPendingAfterDateAndOmitsOtherMarkers() {
    #expect(subtitle(labelTransaction()) == "Today · Uncategorized")
    #expect(subtitle(labelTransaction(pending: true), category: "Synthetic Food") == "Today · Pending · Synthetic Food")
    let recurring = TransactionRecurring(id: "r1", name: "Synthetic Bill", frequency: "monthly")
    #expect(subtitle(labelTransaction(reconciled: true, recurring: recurring), category: "Synthetic Food") == "Today · Synthetic Food")
}

@Test func transactionSplitsCountDistinctPeopleAndKeepTheOwnersShare() {
    let lines = [labelLine(-400), labelLine(-200, person: "p1"), labelLine(-400, person: "p1")]
    #expect(subtitle(labelTransaction(pending: true, lines: lines)) == "Today · Pending · Split with Synthetic Quill · yours $4.00")
    #expect(subtitle(labelTransaction(lines: lines + [labelLine(0, person: "p2")])) == "Today · Split · 2 people · yours $4.00")
    let categories = [labelLine(-400, category: "c1"), labelLine(-600, category: "c2")]
    #expect(subtitle(labelTransaction(lines: categories)) == "Today · Split")
    #expect(subtitle(labelTransaction(lines: [labelLine(-1000, person: "p1")])) == "Today · Split with Synthetic Quill · yours $0.00")
    #expect(subtitle(labelTransaction(amount: 1000, lines: [labelLine(400), labelLine(600, person: "p1")]))
        == "Today · Split with Synthetic Quill · yours $4.00")
}

@Test func paidByAndForgivenessTakePrecedenceOverSplits() {
    let lines = [labelLine(-400), labelLine(-600, person: "p1")]
    #expect(subtitle(labelTransaction(pending: true, payer: "p1")) == "Today · Pending · Paid by Synthetic Quill · yours $10.00")
    #expect(subtitle(labelTransaction(payer: "p1", lines: lines)) == "Today · Paid by Synthetic Quill · yours $10.00")
    #expect(subtitle(labelTransaction(amount: 0, pending: true, lines: lines, forgiven: true)) == "Today · Pending · Forgiven")
    #expect(subtitle(labelTransaction(payer: "p1", lines: lines, forgiven: true)) == "Today · Forgiven")
}
