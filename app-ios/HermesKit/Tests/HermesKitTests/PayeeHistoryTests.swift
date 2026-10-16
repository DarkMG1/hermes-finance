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
    #expect(row.totalCents == nil && row.upcoming && row.reimbursed)
}
