import Foundation

/// A rectangle normalized 0...1 with the origin at the top left. Not CGRect: Foundation's CGRect has no geometry outside CoreGraphics.
public struct Box: Sendable, Equatable {
    public var x, y, w, h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    var midY: Double { y + h / 2 }
}

/// One recognized line of text.
public struct TextLine: Sendable {
    public let text: String
    public let box: Box

    public init(text: String, box: Box) {
        self.text = text
        self.box = box
    }
}

public enum Redaction {
    // Same shapes as the server's scrubIdentifiers: a hyphen, en or em dash, dot or run of spaces between groups; an SSN/ITIN has both
    // separators or neither (so a ZIP+4 is kept), an EIN one. A `$` before or `.digit` after makes it an amount.
    private static let sep = "(?:[-\u{2013}\u{2014}.]| +)"
    // swiftlint:disable force_try
    private static let identifier = try! NSRegularExpression(
        pattern: "(?<![\\d$])(?:\\d{3}(?:\(sep)\\d{2}\(sep)|\\d{2})\\d{4}|\\d{2}\(sep)\\d{7})(?!\\d|\\.\\d)")
    private static let account = try! NSRegularExpression(pattern: "(?<![\\d.,$])\\d{8,17}(?![\\d.,])")
    private static let keyword = try! NSRegularExpression(pattern: "\\b(?:account|acct|routing|aba\\b|rtn\\b)", options: .caseInsensitive)
    // swiftlint:enable force_try

    /// Boxes to black out: identifier matches on a line, plus long digit runs on or next to account/routing words.
    /// Lines on one row are read together, so an identifier Vision split into pieces is still found.
    public static func boxes(_ lines: [TextLine], padding: Double = 0.004) -> [Box] {
        var rows: [[TextLine]] = []
        for line in lines.sorted(by: { $0.box.midY < $1.box.midY }) {
            if let first = rows.last?.first, abs(first.box.midY - line.box.midY) < first.box.h / 2 {
                rows[rows.count - 1].append(line)
            } else {
                rows.append([line])
            }
        }
        let keywordRows = rows.map { row in row.contains { has(keyword, $0.text) } }
        var found: [Box] = []
        for row in rows {
            let near = rows.indices.contains { keywordRows[$0] && abs(rows[$0][0].box.midY - row[0].box.midY) <= 2 * row[0].box.h }
            found += spans(row.sorted { $0.box.x < $1.box.x }, near ? [identifier, account] : [identifier])
        }
        return merge(found.map { b in
            let x = max(b.x - padding, 0), y = max(b.y - padding, 0)
            return Box(x: x, y: y, w: min(b.x + b.w + padding, 1) - x, h: min(b.y + b.h + padding, 1) - y)
        })
    }

    private static func has(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(location: 0, length: text.utf16.count)) != nil
    }

    /// The row's text joined by spaces (none next to a separator), each match mapped back to the part of every line it covers.
    private static func spans(_ row: [TextLine], _ patterns: [NSRegularExpression]) -> [Box] {
        var text = ""
        var starts: [Int] = []
        for line in row {
            if !text.isEmpty, !"-\u{2013}\u{2014}.".contains(text.last!), !"-\u{2013}\u{2014}.".contains(line.text.first ?? " ") { text += " " }
            starts.append(text.utf16.count)
            text += line.text
        }
        let matches = patterns.flatMap { $0.matches(in: text, range: NSRange(location: 0, length: text.utf16.count)) }
        return matches.flatMap { m in
            zip(row, starts).compactMap { line, start -> Box? in
                let count = Double(line.text.utf16.count)
                let lo = max(Double(m.range.location - start), 0), hi = min(Double(m.range.location + m.range.length - start), count)
                guard lo < hi else { return nil }
                let b = line.box
                return Box(x: b.x + b.w * lo / count, y: b.y, w: b.w * (hi - lo) / count, h: b.h)
            }
        }
    }

    private static func merge(_ boxes: [Box]) -> [Box] {
        var out: [Box] = []
        for var box in boxes {
            while let i = out.firstIndex(where: { $0.x < box.x + box.w && box.x < $0.x + $0.w && $0.y < box.y + box.h && box.y < $0.y + $0.h }) {
                let o = out.remove(at: i), x = min(o.x, box.x), y = min(o.y, box.y)
                box = Box(x: x, y: y, w: max(o.x + o.w, box.x + box.w) - x, h: max(o.y + o.h, box.y + box.h) - y)
            }
            out.append(box)
        }
        return out
    }
}
