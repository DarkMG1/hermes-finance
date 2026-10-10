import Foundation

/// A cost split 50/50 apart from a part that is only the owner's; the owner's half takes any odd cent.
public enum SharedCost {
    /// The owner's share, or nil unless 0 < total and 0 ≤ justMine ≤ total.
    public static func yourShare(totalCents: Int, justMineCents: Int) -> Int? {
        guard totalCents > 0, justMineCents >= 0, justMineCents <= totalCents else { return nil }
        let shared = totalCents - justMineCents
        return justMineCents + (shared + 1) / 2
    }
}

/// How a person's balance reads: positive means they owe the owner.
public enum Balance {
    public static func phrase(_ cents: Int) -> String {
        if cents > 0 { return "Owes you \(Money.format(cents))" }
        if cents < 0 { return "You owe \(Money.format(-cents))" }
        return "Settled up"
    }
}
