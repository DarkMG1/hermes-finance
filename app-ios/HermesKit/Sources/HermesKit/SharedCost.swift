import Foundation

/// A cost split 50/50 apart from a part that is only the owner's and a part that is only theirs; the owner's half takes any odd cent.
public enum SharedCost {
    /// The owner's share, or nil unless 0 < total, both parts ≥ 0 and together ≤ total.
    public static func yourShare(totalCents: Int, justMineCents: Int, justTheirsCents: Int = 0) -> Int? {
        guard totalCents > 0, justMineCents >= 0, justTheirsCents >= 0, justMineCents + justTheirsCents <= totalCents else { return nil }
        let shared = totalCents - justMineCents - justTheirsCents
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
