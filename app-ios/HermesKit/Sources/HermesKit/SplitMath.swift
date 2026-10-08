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

    /// Ready to save: at least two lines, every line valid, nothing left over.
    public static func isComplete(total: Int, amounts: [String]) -> Bool {
        amounts.count >= 2 && cents(total: total, amounts: amounts) != nil && remaining(total: total, amounts: amounts) == 0
    }
}
