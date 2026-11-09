import Foundation

public enum PageBudget {
    /// a PDF exported from payroll can hold a run of pay stubs
    public static let maxPages = 24
    /// The read request is at most 8 MB of JSON and base64 adds a third.
    public static let maxBytes = 5_900_000
    /// Past this many pages each is rendered smaller, to keep them all in memory.
    public static let fullSizePages = 8

    /// Every page at the largest long side, then best quality, whose total fits; nil when even the smallest doesn't or a page won't encode.
    public static func fit(pages: Int, encode: (_ page: Int, _ longSide: Double, _ quality: Double) -> Data?) -> [Data]? {
        for side in [2000.0, 1600, 1200] {
            for quality in [0.7, 0.55, 0.4] {
                var out: [Data] = []
                var total = 0
                for page in 0..<pages {
                    guard let data = encode(page, side, quality) else { return nil }
                    total += data.count
                    if total > maxBytes { break }
                    out.append(data)
                }
                if out.count == pages { return out }
            }
        }
        return nil
    }
}

/// Review form text: what an input starts with, and the value its text means (nil when it doesn't parse; callers treat "" as empty).
public enum FieldText {
    public static func cents(_ cents: Int?) -> String {
        guard let cents else { return "" }
        return (cents < 0 ? "-" : "") + Money.format(Int(cents.magnitude)).dropFirst()
    }

    public static func cents(_ text: String, signed: Bool) -> Int? {
        var s = text.trimmingCharacters(in: .whitespaces)
        var sign = 1
        if signed, let first = s.first, "-\u{2212}".contains(first) {
            sign = -1
            s.removeFirst()
        }
        return Money.parse(s).map { $0 * sign }
    }

    public static func number(_ value: Double?) -> String {
        guard let value else { return "" }
        return value == value.rounded() && value.magnitude < 1e15 ? String(Int(value)) : String(value)
    }

    public static func number(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespaces)).flatMap { $0.isFinite ? $0 : nil }
    }

    public static func whole(_ text: String) -> Int? { Int(text.trimmingCharacters(in: .whitespaces)) }

    private static let day = Date.ISO8601FormatStyle(timeZone: TimeZone(identifier: "UTC")!).year().month().day()

    /// A real calendar day written YYYY-MM-DD.
    public static func date(_ text: String) -> String? {
        let s = text.trimmingCharacters(in: .whitespaces)
        return (try? day.parse(s)).map(day.format) == s ? s : nil
    }

    /// "federal" stays lowercase; a state code is uppercased.
    public static func code(_ text: String) -> String {
        let s = text.trimmingCharacters(in: .whitespaces)
        return s.lowercased() == "federal" ? "federal" : s.uppercased()
    }
}

extension Saved where Fields == CreateJobBody {
    /// The job a document's employer names, ignoring case: the same name first, else one name containing the other.
    public static func suggested(for employer: String?, in jobs: [Job]) -> Job? {
        guard let name = employer?.trimmingCharacters(in: .whitespaces).lowercased(), !name.isEmpty else { return nil }
        let names = jobs.map { ($0, ($0.employer ?? "").trimmingCharacters(in: .whitespaces).lowercased()) }.filter { !$0.1.isEmpty }
        return (names.first { $0.1 == name } ?? names.first { $0.1.contains(name) || name.contains($0.1) })?.0
    }
}
