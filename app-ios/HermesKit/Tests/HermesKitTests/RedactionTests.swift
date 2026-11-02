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
}

@Test func aMatchBoxesOnlyItsSpanPaddedAndClamped() throws {
    let text = "SSN 000-00-0000 Wages"
    let box = try #require(Redaction.boxes([TextLine(text: text, box: Box(x: 0.1, y: 0.2, w: 0.42, h: 0.02))], padding: 0.004).first)
    let perChar = 0.42 / Double(text.count)
    #expect(abs(box.x - (0.1 + 4 * perChar - 0.004)) < 1e-9 && abs(box.w - (11 * perChar + 0.008)) < 1e-9)
    #expect(abs(box.y - 0.196) < 1e-9 && abs(box.h - 0.028) < 1e-9)
    let edge = try #require(Redaction.boxes([TextLine(text: "000-00-0000", box: Box(x: 0, y: 0.99, w: 1, h: 0.01))]).first)
    #expect(edge.x == 0 && edge.w == 1 && abs(edge.y - 0.986) < 1e-9 && abs(edge.y + edge.h - 1) < 1e-9)
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
