// Foundation parses Markdown into presentation intents only on Apple platforms
#if canImport(Darwin)
import Foundation

/// An answer's Markdown as blocks for the app to lay out (Text draws inline styles only).
/// Links are dropped: the text comes from a model that read bank data, so a link in it can't be trusted.
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(AttributedString)
    case heading(AttributedString)
    /// `marker` is "•" or "3."; `depth` is 0 for a top-level item. `continued` marks an item's later paragraphs: no marker, same indent.
    case listItem(marker: String, depth: Int, text: AttributedString, continued: Bool)
    /// The first row is the header row; every row has one cell per column.
    case table([[AttributedString]])
    /// A fenced or indented code block's text, without its trailing newline.
    case code(String)

    public static func parse(_ markdown: String) -> [MarkdownBlock] {
        // a single line break stays one, as the model means it (CommonMark would join the lines); code keeps its lines as they are
        let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false)
        var source = "", fenced = false
        for (index, line) in lines.enumerated() {
            let trimmed = line.drop { $0 == " " }
            let fence = trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
            if fence { fenced.toggle() }
            source += line
            if index < lines.count - 1 { source += fenced || fence ? "\n" : "  \n" }
        }
        guard var text = try? AttributedString(markdown: source, options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible))
        else { return [.paragraph(AttributedString(markdown))] }
        text.link = nil
        var blocks: [MarkdownBlock] = [], tableId: Int?, rowId: Int?, items = Set<Int>()
        for (intent, range) in text.runs[\.presentationIntent] {
            var run = AttributedString(text[range])
            run.presentationIntent = nil
            let parts = intent?.components ?? []
            guard let table = parts.first(where: \.kind.isTable), case .table(let columns) = table.kind else {
                tableId = nil
                let item = parts.first(where: \.kind.isListItem)?.identity
                blocks.append(block(parts, run, continued: item.map { !items.insert($0).inserted } ?? false))
                continue
            }
            // Foundation leaves empty cells out, so each cell goes to its column in a row of empty ones
            let row = parts.first(where: \.kind.isRow)?.identity
            var rows: [[AttributedString]] = []
            if tableId == table.identity, case .table(let current) = blocks.last { rows = current } else { blocks.append(.table([])) }
            if row != rowId || rows.isEmpty { rows.append(Array(repeating: AttributedString(), count: columns.count)) }
            if let cell = parts.lazy.compactMap(\.kind.column).first, rows[rows.count - 1].indices.contains(cell) { rows[rows.count - 1][cell] = run }
            blocks[blocks.count - 1] = .table(rows)
            (tableId, rowId) = (table.identity, row)
        }
        return blocks
    }

    /// `parts` run innermost first: a nested item reads paragraph, listItem, orderedList, listItem, unorderedList.
    private static func block(_ parts: [PresentationIntent.IntentType], _ run: AttributedString, continued: Bool) -> MarkdownBlock {
        if parts.contains(where: \.kind.isCode) {
            let code = String(run.characters)
            return .code(code.hasSuffix("\n") ? String(code.dropLast()) : code)
        }
        let lists = parts.indices.filter { parts[$0].kind.isList }
        if let item = parts.firstIndex(where: \.kind.isListItem), case .listItem(let ordinal) = parts[item].kind,
           let list = lists.first(where: { $0 > item }) {
            return .listItem(marker: parts[list].kind == .orderedList ? "\(ordinal)." : "•", depth: lists.count - 1, text: run, continued: continued)
        }
        return parts.contains(where: \.kind.isHeader) ? .heading(run) : .paragraph(run)
    }
}

private extension PresentationIntent.Kind {
    var isTable: Bool { if case .table = self { true } else { false } }
    var isList: Bool { self == .orderedList || self == .unorderedList }
    var isListItem: Bool { if case .listItem = self { true } else { false } }
    var isHeader: Bool { if case .header = self { true } else { false } }
    var isRow: Bool { if case .tableRow = self { true } else { self == .tableHeaderRow } }
    var isCode: Bool { if case .codeBlock = self { true } else { false } }
    var column: Int? { if case .tableCell(let column) = self { column } else { nil } }
}
#endif
