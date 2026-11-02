import Testing
import Foundation
@testable import HermesKit

private func item(_ id: String, left: Int, total: Int? = nil, date: String = "2026-03-01") -> OpenItem {
    OpenItem(transactionId: id, lineId: nil, date: date, payee: id.uppercased(), totalCents: total ?? left, leftCents: left, hasReceipt: false, paybacks: [])
}

@Test func personDecodesOpenItemsAndHistoryFields() throws {
    let detail = try decode(PersonDetail.self, "person")
    #expect(detail.openItems?.isEmpty == false)
    #expect(detail.history.contains { $0.paidBack?.isEmpty == false })
    #expect(detail.history.contains { $0.leftCents != nil })
}

@Test func personDecodesWithoutIOUFieldsFromOlderServer() throws {
    var json = try #require(JSONSerialization.jsonObject(with: fixture("person")) as? [String: Any])
    json.removeValue(forKey: "openItems")
    var history = try #require(json["history"] as? [[String: Any]])
    for i in history.indices { history[i].removeValue(forKey: "leftCents"); history[i].removeValue(forKey: "paidBack") }
    json["history"] = history
    let detail = try JSONDecoder().decode(PersonDetail.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(detail.openItems == nil)
}

@Test func transactionDecodesIOUAndWithoutItFromOlderServer() throws {
    _ = try decode(LedgerTransaction.self, "transaction")
    let t = try decode(LedgerTransaction.self, "transaction-iou")
    #expect(t.iou != nil)
    var json = try #require(JSONSerialization.jsonObject(with: fixture("transaction-iou")) as? [String: Any])
    json.removeValue(forKey: "iou")
    let old = try JSONDecoder().decode(LedgerTransaction.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(old.iou == nil)
}

@Test func paybackChoicesAndCleanupDecode() throws {
    let choices = try decode(PaybackChoices.self, "payback-choices")
    #expect(choices.linked.map(\.lineId) == ["line-2"])
    #expect(choices.items.contains { $0.lineId == "line-2" })
    let cleanup = try decode(ReimbursementsCleanup.self, "reimbursements-cleanup")
    #expect(cleanup.rows.first?.transaction.id == "txn-10")
    #expect(cleanup.rows.allSatisfy { $0.lineId == nil })
}

@Test func reachableUnticksItemsThePaybackCantReachAndCapsAt200() {
    let items = [item("a", left: 2000, date: "2026-03-01"), item("b", left: 3000, date: "2026-03-02")]
    #expect(PaybackFill.reachable(items, selected: ["a|", "b|"], paybackCents: 2000) == ["a|"])
    #expect(PaybackFill.reachable(items, selected: ["a|", "b|"], paybackCents: 2500) == ["a|", "b|"])
    let many = (0..<250).map { item("i\($0)", left: 1) }
    #expect(PaybackFill.reachable(many, selected: Set(many.map(\.id)), paybackCents: 1000).count == PaybackFill.maxItems)
    #expect(PaybackFill.amounts(many, selected: Set(many.map(\.id)), paybackCents: 1000).count == PaybackFill.maxItems)
}

@Test func exactMatchIsPreselectedAndFirst() {
    let items = [item("a", left: 1000), item("b", left: 2500), item("c", left: 2500)]
    #expect(PaybackFill.ordered(items, paybackCents: 2500).map(\.transactionId) == ["b", "a", "c"])
    #expect(PaybackFill.preselected(items, paybackCents: 2500) == ["b|"])
    #expect(PaybackFill.preselected(items, paybackCents: 999).isEmpty)
}

@Test func amountsFillOldestFirstUpToThePaybackLastOnePartial() {
    let items = [item("a", left: 1000, date: "2026-03-01"), item("b", left: 2000, date: "2026-03-02"), item("c", left: 3000, date: "2026-03-03")]
    let filled = PaybackFill.amounts(items, selected: ["c|", "a|", "b|"], paybackCents: 2500)
    #expect(filled == [PaybackItem(transactionId: "a", lineId: nil, amountCents: 1000), PaybackItem(transactionId: "b", lineId: nil, amountCents: 1500)])
}

@Test func amountsFromTheServerListFillOldestFirstEvenWhenTheExactMatchIsNewest() {
    let items = [item("a", left: 1000, date: "2026-03-01"), item("b", left: 2500, date: "2026-03-02")]
    let filled = PaybackFill.amounts(items, selected: PaybackFill.preselected(items, paybackCents: 2500).union(["a|"]), paybackCents: 2500)
    #expect(filled.map(\.transactionId) == ["a", "b"])
    #expect(filled.map(\.amountCents) == [1000, 1500])
}

@Test func statusLines() {
    func tag(_ amount: Int, _ iou: TransactionIOU?) -> String {
        TransactionLabel.tag(personName: "Synthetic Quill", categoryName: "", amountCents: amount, iou: iou)
    }
    #expect(tag(-6000, TransactionIOU(leftCents: 6000, paidBack: [])) == "Synthetic Quill owes")
    #expect(tag(-6000, TransactionIOU(leftCents: 2000, paidBack: [])) == "Synthetic Quill owes · \(Money.format(2000)) left")
    #expect(tag(-6000, TransactionIOU(leftCents: 0, paidBack: [])) == "Synthetic Quill repaid")
    let one = [PaidBack(transactionId: "c", lineId: nil, amountCents: 6000, payee: "SYNTHETIC CONCERT")]
    #expect(tag(6000, TransactionIOU(leftCents: nil, paidBack: one)) == "Synthetic Quill repaid · SYNTHETIC CONCERT")
    #expect(tag(6000, TransactionIOU(leftCents: nil, paidBack: one + one)) == "Synthetic Quill repaid · 2 items")
    #expect(tag(6000, TransactionIOU(leftCents: nil, paidBack: [])) == "Synthetic Quill repaid")
    #expect(tag(6000, TransactionIOU(leftCents: nil, paidBack: [PaidBack(transactionId: "c", lineId: nil, amountCents: 6000)])) == "Synthetic Quill repaid")
    let noPayee = [PaidBack(transactionId: "c", lineId: nil, amountCents: 6000, payee: "")]
    #expect(tag(6000, TransactionIOU(leftCents: nil, paidBack: noPayee)) == "Synthetic Quill repaid")
    #expect(tag(6000, nil) == "Synthetic Quill repaid")
}
