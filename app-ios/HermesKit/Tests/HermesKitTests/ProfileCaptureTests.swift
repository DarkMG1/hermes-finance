import Foundation
import Testing
@testable import HermesKit

@Test func pageBudgetStepsDownUntilTheTotalFits() {
    var tried: [String] = []
    let pages = PageBudget.fit(pages: 3) { page, side, quality in
        tried.append("\(page)@\(Int(side))/\(quality)")
        // 1,000,000 bytes per page at 2000 px and 0.7, shrinking with side and quality
        return Data(count: Int(1_000_000 * side / 2000 * quality / 0.7))
    }
    #expect(pages?.count == 3 && (pages?.reduce(0) { $0 + $1.count } ?? .max) <= PageBudget.maxBytes)
    // quality steps before size: 2000 px at 0.55 is 2,357,142 in all, too big; at 0.4 it is 1,714,285
    #expect(tried.last == "2@2000/0.4" && tried.first == "0@2000/0.7")
    #expect(PageBudget.fit(pages: 1) { _, _, _ in Data(count: 2_100_001) } == nil)
    #expect(PageBudget.fit(pages: 2) { page, _, _ in page == 1 ? nil : Data(count: 10) } == nil)
    #expect(PageBudget.fit(pages: 2) { _, _, _ in Data(count: 1_050_000) }?.count == 2)
}

@Test func fieldTextRoundTrips() {
    #expect(FieldText.cents(123_456) == "1,234.56" && FieldText.cents(-500) == "-5.00" && FieldText.cents(nil) == "")
    #expect(FieldText.cents("1,234.56", signed: false) == 123_456 && FieldText.cents(" $12 ", signed: false) == 1200)
    #expect(FieldText.cents("-5.00", signed: true) == -500 && FieldText.cents("\u{2212}5", signed: true) == -500)
    #expect(FieldText.cents("-5.00", signed: false) == nil && FieldText.cents("abc", signed: true) == nil && FieldText.cents("", signed: false) == nil)
    #expect(FieldText.number(400) == "400" && FieldText.number(12.5) == "12.5" && FieldText.number(" 12.5 ") == 12.5 && FieldText.number("x") == nil)
    #expect(FieldText.number("inf") == nil && FieldText.whole("2025") == 2025 && FieldText.whole("20.5") == nil)
    #expect(FieldText.date("2026-02-28") == "2026-02-28" && FieldText.date("2026-02-30") == nil && FieldText.date("2026-2-3") == nil)
    #expect(FieldText.date("02/28/2026") == nil && FieldText.code("Federal") == "federal" && FieldText.code(" st ") == "ST")
}

@Test func jobSuggestedByEmployerIgnoringCase() throws {
    let jobs = try JSONDecoder().decode([Job].self, from: Data(#"""
        [{"id":"a","employer":"Synthetic Employer Holdings"},{"id":"b","employer":"SYNTHETIC EMPLOYER"},{"id":"c","employer":"Synthetic Wren"}]
        """#.utf8))
    #expect(Job.suggested(for: "synthetic employer ", in: jobs)?.id == "b")
    #expect(Job.suggested(for: "Synthetic Wren LLC", in: jobs)?.id == "c")
    #expect(Job.suggested(for: "Holdings", in: jobs)?.id == "a")
    #expect(Job.suggested(for: "Synthetic Moss", in: jobs) == nil && Job.suggested(for: nil, in: jobs) == nil && Job.suggested(for: " ", in: jobs) == nil)
}
