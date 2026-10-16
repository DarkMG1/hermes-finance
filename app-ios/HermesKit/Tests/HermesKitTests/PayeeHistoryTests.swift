import Foundation
import Testing
@testable import HermesKit

@Test func payeeHistoryFixtureDecodes() throws {
    let history = try JSONDecoder().decode(PayeeHistory.self, from: try fixture("payee-history"))
    let row = try #require(history.rows.first)
    #expect(history.months.count == 12 && history.months.last?.month == "2026-03")
    #expect(row.id == "txn-3" && row.shareCents == 2500 && row.totalCents == 4000)
}
