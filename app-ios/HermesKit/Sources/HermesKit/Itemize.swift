import Foundation

public struct ReceiptItem: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let amountCents: Int
    /// "me" and/or person ids.
    public let people: [String]
}

public struct Itemization: Codable, Sendable {
    public let items: [ReceiptItem]
    public let taxCents: Int?
    public let tipCents: Int?
    public let feesCents: Int?
    public let totalCents: Int?
    /// nil until Claude has read the receipt.
    public let readAt: String?
    /// The split changed since these items were last saved.
    public let handEdited: Bool
}

public struct SaveItemsBody: Encodable, Sendable, Equatable {
    public struct Item: Encodable, Sendable, Equatable {
        public let name: String
        public let amountCents: Int
        public let people: [String]
        public init(name: String, amountCents: Int, people: [String]) { self.name = name; self.amountCents = amountCents; self.people = people }
    }
    public let items: [Item]
    public let taxCents: Int
    public let tipCents: Int
    public let feesCents: Int
    public init(items: [Item], taxCents: Int, tipCents: Int, feesCents: Int) {
        self.items = items; self.taxCents = taxCents; self.tipCents = tipCents; self.feesCents = feesCents
    }
}

/// The server's share math (server/src/itemize.ts), for the live preview; both are tested against shared/test-vectors/item-shares.json.
public enum ItemShares {
    public static let me = "me"

    public struct Item: Sendable, Equatable {
        public let amountCents: Int
        public let people: [String]
        public init(amountCents: Int, people: [String]) { self.amountCents = amountCents; self.people = people }
    }

    public struct Share: Codable, Sendable, Equatable {
        public let person: String
        public let cents: Int
    }

    public struct Result: Sendable, Equatable {
        public let shares: [Share]
        /// The bank amount minus the receipt (items + tax + tip + fees).
        public let gapCents: Int
    }

    /// nil when the items can't be shared out: no items, nobody (or someone twice) on an item, items or a person's items
    /// adding up to zero or less, a target of zero or less, a share of zero cents, or amounts too big to multiply.
    public static func compute(items: [Item], taxCents: Int, tipCents: Int, feesCents: Int, targetCents: Int) -> Result? {
        guard !items.isEmpty, targetCents > 0 else { return nil }
        guard let itemsTotal = sum(items.map(\.amountCents)), itemsTotal > 0, let (order, base) = itemTotals(items) else { return nil }
        let people = order.contains(me) ? [me] + order.filter { $0 != me } : order
        guard people.allSatisfy({ (base[$0] ?? 0) > 0 }) else { return nil }
        var cents: [String: Int] = [:]
        var frac: [String: Int] = [:]
        for p in people {
            let (n, overflow) = (base[p] ?? 0).multipliedReportingOverflow(by: targetCents)
            if overflow { return nil }
            cents[p] = n / itemsTotal
            frac[p] = n % itemsTotal
        }
        var left = targetCents - cents.values.reduce(0, +)
        let ranked = people.filter { $0 != me }.sorted { a, b in
            let fa = frac[a] ?? 0, fb = frac[b] ?? 0
            return fa != fb ? fa > fb : people.firstIndex(of: a)! < people.firstIndex(of: b)!
        }
        let queue = people.contains(me) ? [me] + ranked : ranked
        var i = 0
        while left > 0 {
            cents[queue[i], default: 0] += 1
            i += 1
            left -= 1
        }
        guard people.allSatisfy({ (cents[$0] ?? 0) > 0 }) else { return nil }
        guard let receipt = sum([itemsTotal, taxCents, tipCents, feesCents]) else { return nil }
        let (gap, overflow) = targetCents.subtractingReportingOverflow(receipt)
        if overflow { return nil }
        return Result(shares: people.map { Share(person: $0, cents: cents[$0] ?? 0) }, gapCents: gap)
    }

    /// Each person's item total and the order people first appear. Items split evenly; an item's odd cents go to whoever
    /// has had the fewest so far (a discount's come back from whoever has had the most), ties to "me" first, then list order.
    private static func itemTotals(_ items: [Item]) -> ([String], [String: Int])? {
        var order: [String] = []
        var base: [String: Int] = [:]
        var odd: [String: Int] = [:]
        for item in items {
            guard !item.people.isEmpty, Set(item.people).count == item.people.count else { return nil }
            for p in item.people where !order.contains(p) { order.append(p) }
            let people = item.people.contains(me) ? [me] + item.people.filter { $0 != me } : item.people
            let each = item.amountCents / people.count
            let rem = item.amountCents - each * people.count
            let sign = rem.signum()
            let takers = people.enumerated().sorted { a, b in
                let oa = sign * (odd[a.element] ?? 0), ob = sign * (odd[b.element] ?? 0)
                return oa != ob ? oa < ob : a.offset < b.offset
            }.prefix(abs(rem)).map(\.element)
            for p in people {
                guard let b = sum([base[p] ?? 0, each, takers.contains(p) ? sign : 0]) else { return nil }
                base[p] = b
            }
            for p in takers { odd[p, default: 0] += sign }
        }
        return (order, base)
    }

    private static func sum(_ values: [Int]) -> Int? {
        var total = 0
        for v in values {
            let (t, overflow) = total.addingReportingOverflow(v)
            if overflow { return nil }
            total = t
        }
        return total
    }
}
