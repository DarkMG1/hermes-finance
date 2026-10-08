import Foundation
import Testing
@testable import HermesKit

@Test func monthNavigationAndQuery() {
    let p = SpendingPeriod.current(today: "2026-01-15")
    #expect(p.title == "January 2026")
    #expect(p.queryItems == [URLQueryItem(name: "period", value: "month"), URLQueryItem(name: "date", value: "2026-01")])
    #expect(p.previous().title == "December 2025")
    #expect(p.previous().next() == p)
    #expect(!p.canGoNext(today: "2026-01-15"))
    #expect(p.previous().canGoNext(today: "2026-01-15"))
}

@Test func yearNavigationAndQuery() {
    let y = SpendingPeriod.current(today: "2026-10-08").with(kind: .year)
    #expect(y.title == "2026")
    #expect(y.queryItems == [URLQueryItem(name: "period", value: "year"), URLQueryItem(name: "date", value: "2026")])
    #expect(y.previous().title == "2025")
    #expect(!y.canGoNext(today: "2026-10-08"))
    #expect(y.with(kind: .month).title == "October 2026")
}

@Test func titleDoesNotTrapOnBadMonth() {
    #expect(SpendingPeriod.current(today: "2026-13-01").title == "December 2026")
    #expect(SpendingPeriod.current(today: "2026-00-01").title == "January 2026")
}
