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
    // The server's scrubIdentifiers uses the same rules. A hyphen, en or em dash, dot or run of spaces between groups; an SSN/ITIN has both
    // separators or neither (so a ZIP+4 is kept), an EIN one; a form's one-digit-per-cell box reads as nine digits split by spaces.
    // A `$` before or `.digit` after makes it an amount.
    private static let sep = "(?:[-\u{2013}\u{2014}.]| +)"
    // swiftlint:disable force_try
    private static let identifier = try! NSRegularExpression(
        pattern: "(?<![\\d$])(?:\\d{3}(?:\(sep)\\d{2}\(sep)|\\d{2})\\d{4}|\\d{2}\(sep)\\d{7}|\\d(?: +\\d){8})(?!\\d|\\.\\d)")
    // with an account word near: 8 to 17 digits in a run, or in groups split by spaces or hyphens (not a date)
    private static let account = try! NSRegularExpression(pattern: "(?<![\\d$]|\\d[.,])\\d{8,17}(?!\\d|[.,]\\d)")
    private static let groups = try! NSRegularExpression(pattern: "(?<![\\d$]|\\d[.,])\\d{3,}(?:[ -]\\d{2,}){1,4}(?!\\d|[.,]\\d)")
    private static let date = try! NSRegularExpression(pattern: "^\\d{4}[- ]\\d{1,2}[- ]\\d{1,2}$")
    private static let keyword = try! NSRegularExpression(pattern: "\\b(?:accounts?|acct|routing|aba|rtn)\\b", options: .caseInsensitive)
    // under an identifier's label, digits Vision dropped some of (cell borders) still go: any run of 5+ digits, spaces and dashes
    private static let idKeyword = try! NSRegularExpression(
        pattern: "\\b(?:social security|ssn|itin|taxpayer identification|identifying number|employer identification|ein)\\b", options: .caseInsensitive)
    private static let digitRun = try! NSRegularExpression(pattern: "(?<![\\d$]|\\d[.,])\\d[\\d \\-\u{2013}\u{2014}]*\\d(?!\\d|[.,]\\d)")
    // swiftlint:enable force_try
    /// Letters OCR reads for digits on faint prints; identifiers are also matched with them read as digits.
    private static let confusable: [Character: Character] = ["O": "0", "o": "0", "I": "1", "l": "1", "S": "5", "B": "8"]

    /// Boxes to black out: identifier matches on a line, long digit runs on or near account/routing words (up to 4 lines away), and
    /// digit runs of 5+ on or just below an identifier's label (up to 2 lines).
    /// Lines on one row are read together, so an identifier Vision split into pieces is still found. `locate` gives the box of a line's
    /// matched characters (UTF-16 offsets into its text), as Vision measures them; without one the whole line is boxed.
    public static func boxes(_ lines: [TextLine], padding: Double = 0.004, locate: (_ line: Int, _ range: Range<Int>) -> Box? = { _, _ in nil }) -> [Box] {
        var rows: [[(index: Int, line: TextLine)]] = []
        for item in lines.enumerated().map({ (index: $0.offset, line: $0.element) }).sorted(by: { $0.line.box.midY < $1.line.box.midY }) {
            if let first = rows.last?.first?.line, abs(first.box.midY - item.line.box.midY) < first.box.h / 2 {
                rows[rows.count - 1].append(item)
            } else {
                rows.append([item])
            }
        }
        let keywordRows = rows.map { row in row.contains { has(keyword, $0.line.text) } }
        let labelRows = rows.map { row in row.contains { has(idKeyword, $0.line.text) } }
        var found: [Box] = []
        for row in rows {
            let h = row[0].line.box.h, y = row[0].line.box.midY
            let near = rows.indices.contains { keywordRows[$0] && abs(rows[$0][0].line.box.midY - y) <= 4 * h }
            let labelled = rows.indices.contains { labelRows[$0] && (0...2 * h).contains(y - rows[$0][0].line.box.midY) }
            found += spans(row.sorted { $0.line.box.x < $1.line.box.x }, accounts: near, labelled: labelled)
                .map { locate($0.index, $0.range) ?? lines[$0.index].box }
        }
        return merge(found.map { b in
            let x = max(b.x - padding, 0), y = max(b.y - padding, 0)
            return Box(x: x, y: y, w: min(b.x + b.w + padding, 1) - x, h: min(b.y + b.h + padding, 1) - y)
        })
    }

    /// The pages (counting from 1) of a document that normally carries an SSN or EIN on which nothing is blacked out.
    public static func pagesToCheck(kind: ProfileKind, boxCounts: [Int]) -> [Int] {
        kind == .offer ? [] : boxCounts.enumerated().filter { $0.element == 0 }.map { $0.offset + 1 }
    }

    private static func has(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(location: 0, length: text.utf16.count)) != nil
    }

    /// The row's text joined by spaces (none next to a separator), each match mapped back to the characters of every line it covers.
    private static func spans(_ row: [(index: Int, line: TextLine)], accounts: Bool, labelled: Bool) -> [(index: Int, range: Range<Int>)] {
        var text = ""
        var starts: [Int] = []
        for (_, line) in row {
            if !text.isEmpty, !"-\u{2013}\u{2014}.".contains(text.last!), !"-\u{2013}\u{2014}.".contains(line.text.first ?? " ") { text += " " }
            starts.append(text.utf16.count)
            text += line.text
        }
        let all = NSRange(location: 0, length: text.utf16.count), ns = text as NSString
        let digits = { (r: NSRange) in ns.substring(with: r).filter(\.isASCII).filter(\.isNumber).count }
        // a read-as-digits match counts only with most of its digits real, so words never black out
        let read = String(text.map { confusable[$0] ?? $0 })
        var matches = identifier.matches(in: text, range: all).map(\.range)
            + identifier.matches(in: read, range: all).map(\.range).filter { digits($0) >= 6 }
        if accounts {
            matches += account.matches(in: text, range: all).map(\.range)
                + groups.matches(in: text, range: all).map(\.range).filter { (8...17).contains(digits($0)) && !has(date, ns.substring(with: $0)) }
        }
        if labelled {
            matches += digitRun.matches(in: text, range: all).map(\.range).filter { digits($0) >= 5 && !has(date, ns.substring(with: $0)) }
        }
        // the read-as-digits pass finds most matches again
        var seen = Set<[Int]>()
        return matches.filter { seen.insert([$0.location, $0.length]).inserted }.flatMap { m in
            zip(row, starts).compactMap { item, start -> (index: Int, range: Range<Int>)? in
                let lo = max(m.location - start, 0), hi = min(m.location + m.length - start, item.line.text.utf16.count)
                return lo < hi ? (item.index, lo..<hi) : nil
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

/// Bumped whenever what was shown must hide again (background, close); a reply that started under an older value is dropped.
public struct RevealGeneration: Sendable {
    public private(set) var value = 0
    public init() {}
    public mutating func invalidate() { value += 1 }
    public func isCurrent(_ started: Int) -> Bool { started == value }
}
