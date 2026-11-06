import Foundation
import Testing
@testable import HermesKit

private func line(_ text: String, y: Double = 0.5, x: Double = 0, w: Double = 1) -> TextLine {
    TextLine(text: text, box: Box(x: x, y: y, w: w, h: 0.02))
}

private func boxed(_ text: String) -> Bool { !Redaction.boxes([line(text)]).isEmpty }

@Test func identifiersAreBoxed() {
    for text in ["000-00-0000", "000 00 0000", "000  00  0000", "000000000", "000.00.0000", "000\u{2013}00\u{2014}0000", "SSN:000-00-0000",
                 "SSN000-00-0000", "ITIN 900-70-0000", "EIN 00-0000000", "00 0000000"] {
        #expect(boxed(text), "\(text)")
    }
}

@Test func amountsDatesZipsAndPhonesAreNotBoxed() {
    for text in ["$12,345.67", "12345.67", "2026-04-15", "04/15/2026", "12345", "Synthetic City, ST 12345-6789", "00000-0000", "(555) 555-0100", "555-555-0100",
                 "555.555.0100", "555 555 0100", "5555550100", "$000000000", "000000000.00", "$00-0000000", "00-0000000.00", "0000000000", "000-00-00000",
                 "000-000000", "00001234567"] {
        #expect(!boxed(text), "\(text)")
    }
}

@Test func accountNumbersNeedAKeywordOnTheirLineOrNextToIt() {
    #expect(!Redaction.boxes([line("Account number 00001234567")]).isEmpty)
    #expect(!Redaction.boxes([line("ACCT# 00001234567")]).isEmpty)
    #expect(!Redaction.boxes([line("Routing", y: 0.40), line("00001234567", y: 0.42)]).isEmpty, "line above")
    #expect(!Redaction.boxes([line("00001234567", y: 0.40), line("ABA", y: 0.42)]).isEmpty, "line below")
    #expect(!Redaction.boxes([line("RTN", y: 0.40, x: 0, w: 0.2), line("00001234567", y: 0.40, x: 0.5, w: 0.3)]).isEmpty, "same row")
    #expect(Redaction.boxes([line("Routing", y: 0.10), line("00001234567", y: 0.50)]).isEmpty, "far away")
    #expect(Redaction.boxes([line("Account total $00001234567.00")]).isEmpty, "an amount")
    #expect(Redaction.boxes([line("Alabama 00001234567")]).isEmpty, "aba inside a word")
    #expect(Redaction.boxes([line("Accounting 00001234567")]).isEmpty, "not a whole word")
    #expect(!Redaction.boxes([line("Account 00001234567.")]).isEmpty, "sentence end")
    #expect(!Redaction.boxes([line("Acct.No.00001234567")]).isEmpty, "abbreviation dots")
    #expect(Redaction.boxes([line("Account $12,345.67")]).isEmpty)
}

@Test func aMatchIsBoxedWhereVisionMeasuresItsCharactersPaddedAndClamped() throws {
    let lines = [line("Wages 1,234.56", y: 0.1), TextLine(text: "SSN 000-00-0000 Wages", box: Box(x: 0.1, y: 0.2, w: 0.42, h: 0.02))]
    var asked: [(Int, String)] = []
    let measured = Box(x: 0.2, y: 0.2, w: 0.15, h: 0.02)
    let box = try #require(Redaction.boxes(lines, padding: 0.004) { index, range in
        let utf16 = Array(lines[index].text.utf16)
        asked.append((index, String(decoding: utf16[range], as: UTF16.self)))
        return measured
    }.first)
    #expect(asked.count == 1 && asked[0] == (1, "000-00-0000"), "only the identifier's own characters are measured")
    #expect(abs(box.x - 0.196) < 1e-9 && abs(box.w - 0.158) < 1e-9 && abs(box.y - 0.196) < 1e-9 && abs(box.h - 0.028) < 1e-9)
    let edge = try #require(Redaction.boxes([TextLine(text: "000-00-0000", box: Box(x: 0, y: 0.99, w: 1, h: 0.01))]).first)
    #expect(edge.x == 0 && edge.w == 1 && abs(edge.y - 0.986) < 1e-9 && abs(edge.y + edge.h - 1) < 1e-9)
}

@Test func withoutAMeasureTheWholeLineIsBoxed() throws {
    // proportional glyphs put the digits anywhere on the line, so a guess by character count could leave edge digits showing
    let whole = Box(x: 0.1, y: 0.2, w: 0.8, h: 0.02)
    let same = { (b: Box) in abs(b.x - whole.x) < 1e-9 && abs(b.y - whole.y) < 1e-9 && abs(b.w - whole.w) < 1e-9 && abs(b.h - whole.h) < 1e-9 }
    #expect(Redaction.boxes([TextLine(text: "Social Security Number: 000-00-0000", box: whole)], padding: 0).map(same) == [true])
    #expect(Redaction.boxes([TextLine(text: "Employee ID 00-0000000 SYNTHETIC EMPLOYER INC", box: whole)], padding: 0) { _, _ in nil }.map(same) == [true])
}

@Test func groupedAccountNumbersNearTheirWordAreBoxedAndDatesAreNot() {
    for text in ["Account 0000 1234 5678", "Acct 0000-1234-56", "Routing 000 000 000", "Account number: 000-0000-00000"] { #expect(boxed(text), "\(text)") }
    for text in ["Account opened 2026-04-15", "Account 2026 04 15", "Account 0000 12", "Account total $0,000 1234 5678.00", "Phone 555 555 0100 1234"] {
        #expect(!boxed(text), "\(text)")
    }
}

@Test func accountWordsReachFourLinesDown() {
    #expect(!Redaction.boxes([line("Account", y: 0.40), line("00001234567", y: 0.46)]).isEmpty, "a direct-deposit table's third row")
    #expect(!Redaction.boxes([line("Account", y: 0.40), line("0000 1234 5678", y: 0.48)]).isEmpty)
    #expect(Redaction.boxes([line("Account", y: 0.40), line("00001234567", y: 0.50)]).isEmpty, "five lines away")
}

@Test func identifiersReadWithLettersForDigitsAreBoxed() {
    for text in ["000-OO-0000", "SSN 0O0-00-000O", "12-345l789", "EIN 00-00000O0", "S000-00-0000", "B00 00 0000"] {
        #expect(boxed(text), "\(text)")
    }
    for text in ["OOO-OO-OOOO", "SOLID BOSS", "Ollie Sullivan", "ISO 9001", "Box 12 code DD 0O"] { #expect(!boxed(text), "\(text)") }
}

@Test func pagesWithNothingHiddenAreFlaggedOnDocumentsThatCarryIDs() {
    #expect(Redaction.pagesToCheck(kind: .taxForm, boxCounts: [2, 0, 1, 0]) == [2, 4])
    #expect(Redaction.pagesToCheck(kind: .payStub, boxCounts: [0]) == [1])
    #expect(Redaction.pagesToCheck(kind: .taxReturn, boxCounts: [1, 3]).isEmpty)
    #expect(Redaction.pagesToCheck(kind: .offer, boxCounts: [0, 0]).isEmpty, "an offer letter carries no SSN or EIN")
}

@Test func aRevealStartedBeforeAnInvalidateIsDropped() {
    var generation = RevealGeneration()
    let started = generation.value
    #expect(generation.isCurrent(started))
    generation.invalidate()
    #expect(!generation.isCurrent(started))
    #expect(generation.isCurrent(generation.value))
}

@Test func overlappingBoxesMerge() {
    let boxes = Redaction.boxes([line("000-00-0000 00-0000000", y: 0.5), line("900-70-0000", y: 0.515)])
    #expect(boxes.count == 1)
}

@Test func anIdentifierSplitAcrossRecognizedLinesOnOneRowIsBoxed() {
    let parts = [line("000", y: 0.5, x: 0.1, w: 0.05), line("00", y: 0.501, x: 0.2, w: 0.04), line("0000", y: 0.499, x: 0.3, w: 0.06)]
    let boxes = Redaction.boxes(parts, padding: 0)
    #expect(boxes.count == 3)
    for (b, p) in zip(boxes.sorted { $0.x < $1.x }, parts.map(\.box)) {
        #expect(abs(b.x - p.x) < 1e-9 && abs(b.y - p.y) < 1e-9 && abs(b.w - p.w) < 1e-9 && abs(b.h - p.h) < 1e-9)
    }
    #expect(Redaction.boxes([line("000-00", y: 0.5, x: 0.1, w: 0.1), line("-0000", y: 0.5, x: 0.3, w: 0.1)]).count == 2)
    #expect(Redaction.boxes([line("000 00", y: 0.2), line("0000", y: 0.6)]).isEmpty, "different rows")
}

@Test func aOneDigitPerCellIdentifierIsBoxed() {
    #expect(boxed("0 0 0 0 0 0 0 0 0"))
    #expect(boxed("Your social security number 0 0 0 0 0 0 0 0 0"))
    #expect(!boxed("0 0 0 0 0 0 0 0"), "eight digits")
}

@Test func digitsJustUnderAnIdentifierLabelAreBoxedEvenWithDigitsMissing() {
    let label = line("Your social security number", y: 0.40)
    #expect(!Redaction.boxes([label, line("00 00 00 00", y: 0.42)]).isEmpty, "a cell border dropped a digit")
    #expect(!Redaction.boxes([label, line("0 00 0 0", y: 0.42)]).isEmpty)
    #expect(!Redaction.boxes([line("a Employee's SSN 00 00 00 00", y: 0.40)]).isEmpty, "same line")
    #expect(Redaction.boxes([label, line("2026", y: 0.42)]).isEmpty, "four digits")
    #expect(Redaction.boxes([label, line("48500.00", y: 0.42)]).isEmpty, "an amount")
    #expect(Redaction.boxes([label, line("2026-04-15", y: 0.42)]).isEmpty, "a date")
    #expect(Redaction.boxes([label, line("00 00 00 00", y: 0.50)]).isEmpty, "too far below")
    #expect(Redaction.boxes([label, line("00 00 00 00", y: 0.38)]).isEmpty, "above the label")
    #expect(Redaction.boxes([line("00 00 00 00")]).isEmpty, "no label")
}
