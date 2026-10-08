import Testing
@testable import HermesKit

@Test(arguments: [
    (0, "$0.00"), (5, "$0.05"), (1234, "$12.34"), (123_456_789, "$1,234,567.89"), (-1250, "\u{2212}$12.50"), (100_000, "$1,000.00"),
])
func formats(cents: Int, expected: String) {
    #expect(Money.format(cents) == expected)
}

@Test func showsPlusWhenAsked() {
    #expect(Money.format(300, showPlus: true) == "+$3.00")
    #expect(Money.format(-300, showPlus: true) == "\u{2212}$3.00")
}

@Test(arguments: [
    ("12", 1200), ("12.3", 1230), ("12.34", 1234), (".5", 50), ("1,234.50", 123_450), ("$7", 700), (" 8.00 ", 800), ("0", 0), ("0.07", 7),
])
func parsesValidAmounts(text: String, cents: Int) {
    #expect(Money.parse(text) == cents)
}

@Test(arguments: ["abc", "12.345", "-5", "", ".", "1,23", "1.2.3", "$", "1234567890123", "１２"])
func rejectsInvalidAmounts(text: String) {
    #expect(Money.parse(text) == nil)
}
