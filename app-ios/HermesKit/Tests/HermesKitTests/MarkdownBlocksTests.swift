#if canImport(Darwin)
import Foundation
import Testing
@testable import HermesKit

private func plain(_ text: AttributedString) -> String { String(text.characters) }

@Test func markdownBecomesBlocks() {
    let source = "**Short answer:** $5 at SYNTHETIC GROCER.\nSecond line.\n\n## By category\n\n- one\n- two\n  1. nested\n\n"
        + "| Category | Amount |\n|---|--:|\n| Food | $3 |\n| Gas | $4 |\n\nSee [the bank](https://example.com)."
    let blocks = MarkdownBlock.parse(source)
    guard blocks.count == 7, case .paragraph(let first) = blocks[0], case .heading(let heading) = blocks[1],
          case .listItem(let m1, let d1, let one) = blocks[2], case .listItem(let m2, let d2, _) = blocks[3],
          case .listItem(let m3, let d3, let nested) = blocks[4], case .table(let rows) = blocks[5], case .paragraph(let last) = blocks[6]
    else { Issue.record("\(blocks)"); return }
    #expect(plain(first) == "Short answer: $5 at SYNTHETIC GROCER.\nSecond line.")
    #expect(first.runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized })
    #expect(plain(heading) == "By category")
    #expect([m1, m2, m3] == ["•", "•", "1."] && [d1, d2, d3] == [0, 0, 1] && plain(one) == "one" && plain(nested) == "nested")
    #expect(rows.map { $0.map(plain) } == [["Category", "Amount"], ["Food", "$3"], ["Gas", "$4"]])
    #expect(plain(last) == "See the bank." && !last.runs.contains { $0.link != nil })
    #expect(!blocks.contains { if case .paragraph(let t) = $0 { t.runs.contains { $0.presentationIntent != nil } } else { false } })
}

@Test func twoTablesInARowStaySeparate() {
    let blocks = MarkdownBlock.parse("| A |\n|---|\n| 1 |\n\ntext\n\n| B |\n|---|\n| 2 |")
    guard blocks.count == 3, case .table(let a) = blocks[0], case .table(let b) = blocks[2] else { Issue.record("\(blocks)"); return }
    #expect(a.map { $0.map(plain) } == [["A"], ["1"]] && b.map { $0.map(plain) } == [["B"], ["2"]])
}
#endif
