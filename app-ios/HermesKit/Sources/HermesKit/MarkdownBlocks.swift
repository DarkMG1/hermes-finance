// Foundation parses Markdown into presentation intents only on Apple platforms
#if canImport(Darwin)
import Foundation

/// An answer's Markdown as blocks for the app to lay out (Text draws inline styles only).
/// Links are dropped: the text comes from a model that read bank data, so a link in it can't be trusted.
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(AttributedString)
    case heading(AttributedString)
    /// `marker` is "•" or "3."; `depth` is 0 for a top-level item.
    case listItem(marker: String, depth: Int, text: AttributedString)
    /// The first row is the header row.
    case table([[AttributedString]])

    public static func parse(_ markdown: String) -> [MarkdownBlock] {
        // a single line break stays one, as the model means it (CommonMark would join the lines)
        let source = markdown.replacingOccurrences(of: "\n", with: "  \n")
        guard var text = try? AttributedString(markdown: source, options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible))
        else { return [.paragraph(AttributedString(markdown))] }
        text.link = nil
        var blocks: [MarkdownBlock] = [], tableId: Int?
        for (intent, range) in text.runs[\.presentationIntent] {
            var run = AttributedString(text[range])
            run.presentationIntent = nil
            let parts = intent?.components ?? []
            guard let table = parts.first(where: \.kind.isTable) else {
                tableId = nil
                blocks.append(block(parts, run))
                continue
            }
            if tableId == table.identity, case .table(var rows) = blocks.last {
                if parts.contains(where: { $0.kind == .tableCell(columnIndex: 0) }) { rows.append([run]) } else { rows[rows.count - 1].append(run) }
                blocks[blocks.count - 1] = .table(rows)
            } else {
                blocks.append(.table([[run]]))
            }
            tableId = table.identity
        }
        return blocks
    }

    /// `parts` run innermost first: a nested item reads paragraph, listItem, orderedList, listItem, unorderedList.
    private static func block(_ parts: [PresentationIntent.IntentType], _ run: AttributedString) -> MarkdownBlock {
        let lists = parts.indices.filter { parts[$0].kind.isList }
        if let item = parts.firstIndex(where: \.kind.isListItem), case .listItem(let ordinal) = parts[item].kind,
           let list = lists.first(where: { $0 > item }) {
            return .listItem(marker: parts[list].kind == .orderedList ? "\(ordinal)." : "•", depth: lists.count - 1, text: run)
        }
        return parts.contains(where: \.kind.isHeader) ? .heading(run) : .paragraph(run)
    }
}

private extension PresentationIntent.Kind {
    var isTable: Bool { if case .table = self { true } else { false } }
    var isList: Bool { self == .orderedList || self == .unorderedList }
    var isListItem: Bool { if case .listItem = self { true } else { false } }
    var isHeader: Bool { if case .header = self { true } else { false } }
}
#endif
