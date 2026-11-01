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
          case .listItem(let m1, let d1, let one, false) = blocks[2], case .listItem(let m2, let d2, _, false) = blocks[3],
          case .listItem(let m3, let d3, let nested, false) = blocks[4], case .table(let rows) = blocks[5], case .paragraph(let last) = blocks[6]
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
@Test func emptyTableCellsKeepTheirColumns() {
    let blocks = MarkdownBlock.parse("| A | B | C |\n|---|---|---|\n|  | m | z |\n| x |  |  |\n| p | | w |")
    guard blocks.count == 1, case .table(let rows) = blocks[0] else { Issue.record("\(blocks)"); return }
    #expect(rows.map { $0.map(plain) } == [["A", "B", "C"], ["", "m", "z"], ["x", "", ""], ["p", "", "w"]])
}

@Test func aRowStartingEmptyStaysItsOwnRow() {
    let blocks = MarkdownBlock.parse("| A | B |\n|---|---|\n| 1 | 2 |\n|  | 3 |")
    guard blocks.count == 1, case .table(let rows) = blocks[0] else { Issue.record("\(blocks)"); return }
    #expect(rows.map { $0.map(plain) } == [["A", "B"], ["1", "2"], ["", "3"]])
}

@Test func aListItemsLaterParagraphsHaveNoMarker() {
    let blocks = MarkdownBlock.parse("1. first\n\n   more of first\n2. second")
    guard blocks.count == 3, case .listItem("1.", 0, let first, false) = blocks[0], case .listItem(_, 0, let more, true) = blocks[1],
          case .listItem("2.", 0, _, false) = blocks[2] else { Issue.record("\(blocks)"); return }
    #expect(plain(first) == "first" && plain(more) == "more of first")
}

@Test func codeKeepsItsLinesWithoutTheTrailingNewline() {
    let blocks = MarkdownBlock.parse("Run:\n\n```\nlet a = 1\nlet b = 2\n```\nDone.")
    guard blocks.count == 3, case .code(let code) = blocks[1] else { Issue.record("\(blocks)"); return }
    #expect(code == "let a = 1\nlet b = 2")
    let indented = MarkdownBlock.parse("Run:\n\n    let a = 1\n    let b = 2\n\nDone.")
    guard indented.count == 3, case .code(let four) = indented[1] else { Issue.record("\(indented)"); return }
    #expect(four == "let a = 1\nlet b = 2")
}
#endif
