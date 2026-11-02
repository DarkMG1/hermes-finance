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

@Test func paybackBodyEncodesNullLineId() throws {
    let body = PaybackBody(personId: "p1", lineId: nil, items: [PaybackItem(transactionId: "a", lineId: nil, amountCents: 100)])
    let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
    #expect(json["lineId"] is NSNull)
    let items = try #require(json["items"] as? [[String: Any]])
    #expect(items[0]["lineId"] is NSNull)
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
    #expect(tag(6000, TransactionIOU(leftCents: nil, paidBack: [PaidBack(transactionId: "c", lineId: nil, amountCents: 6000, payee: "")])) == "Synthetic Quill repaid")
    #expect(tag(6000, nil) == "Synthetic Quill repaid")
}
