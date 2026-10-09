import Foundation

/// Split lines are typed as positive amounts; they take the sign of the transaction they divide.
public enum SplitMath {
    /// Signed cents per line, or nil while any line is empty, unparseable or zero.
    public static func cents(total: Int, amounts: [String]) -> [Int]? {
        let parsed = amounts.compactMap(Money.parse)
        guard parsed.count == amounts.count, parsed.allSatisfy({ $0 > 0 }) else { return nil }
        return parsed.map { total < 0 ? -$0 : $0 }
    }

    /// What is still unassigned, as a positive amount when lines fall short and negative when they go over.
    public static func remaining(total: Int, amounts: [String]) -> Int {
        abs(total) - amounts.compactMap(Money.parse).reduce(0, +)
    }

    /// Keeps the lines adding up while one is typed in: the first line absorbs the change, or the last line when the first is the
    /// one being edited. The absorbing line never goes below zero; whatever doesn't fit shows as negative `remaining`.
    public static func balanced(total: Int, amounts: [String], edited: Int) -> [String] {
        guard amounts.count >= 2, amounts.indices.contains(edited) else { return amounts }
        let absorber = edited == 0 ? amounts.count - 1 : 0
        let others = amounts.indices.filter { $0 != absorber }.reduce(0) { $0 + (Money.parse(amounts[$1]) ?? 0) }
        var result = amounts
        result[absorber] = plain(max(0, abs(total) - others))
        return result
    }

    /// "12.45" for 1245 cents: editable text, no currency symbol or separators.
    public static func plain(_ cents: Int) -> String { String(format: "%d.%02d", cents / 100, cents % 100) }

    /// Ready to save: at least two lines, every line valid, nothing left over.
    public static func isComplete(total: Int, amounts: [String]) -> Bool {
        amounts.count >= 2 && cents(total: total, amounts: amounts) != nil && remaining(total: total, amounts: amounts) == 0
    }
}
