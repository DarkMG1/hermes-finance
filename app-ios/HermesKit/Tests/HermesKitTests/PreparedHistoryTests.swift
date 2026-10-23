import Foundation
import Testing
@testable import HermesKit

@Test func chartSelectsNearestPreparedDayAcrossGapsAndDaylightSaving() throws {
    let zone = try #require(TimeZone(identifier: "America/New_York"))
    let history = PreparedHistory(points: [
        NetWorthPoint(date: "2026-03-07", netWorthCents: -300),
        NetWorthPoint(date: "2026-03-08", netWorthCents: 500),
        NetWorthPoint(date: "2026-03-11", netWorthCents: 900)
    ], timeZone: zone)
    #expect(history.points.count == 3 && history.floor == -3)
    #expect(history.point(at: nil) == nil)
    let march7 = Date(timeIntervalSince1970: 1_772_902_800) // March 7, 17:00 UTC (local noon)
    let march8 = march7.addingTimeInterval(23 * 3600)
    #expect(history.points[0].day == march7 && history.points[1].day == march8)
    #expect(history.point(at: march7.addingTimeInterval(-3600))?.value.date == "2026-03-07")
    #expect(history.point(at: march8)?.value.netWorthCents == 500)
    #expect(history.point(at: march8.addingTimeInterval(36 * 3600))?.value.date == "2026-03-08")
    #expect(history.point(at: march8.addingTimeInterval(40 * 3600))?.value.date == "2026-03-11")
    #expect(history.point(at: march8.addingTimeInterval(10 * 86400))?.value.date == "2026-03-11")
    #expect(PreparedHistory(points: []).point(at: march7) == nil)
}
