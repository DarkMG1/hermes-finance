import Foundation

public struct SpendingPeriod: Hashable, Sendable {
    public enum Kind: String, Hashable, Sendable, CaseIterable { case month, year }

    public let kind: Kind
    public let year: Int
    public let month: Int

    private static let monthNames = ["January", "February", "March", "April", "May", "June",
                                     "July", "August", "September", "October", "November", "December"]

    public static func current(today: String) -> SpendingPeriod {
        let parts = today.split(separator: "-").compactMap { Int($0) }
        return SpendingPeriod(kind: .month, year: parts.first ?? 1970, month: parts.count > 1 ? parts[1] : 1)
    }

    public func with(kind: Kind) -> SpendingPeriod { SpendingPeriod(kind: kind, year: year, month: month) }

    public func previous() -> SpendingPeriod {
        if kind == .year { return SpendingPeriod(kind: .year, year: year - 1, month: month) }
        return month == 1 ? SpendingPeriod(kind: .month, year: year - 1, month: 12) : SpendingPeriod(kind: .month, year: year, month: month - 1)
    }

    public func next() -> SpendingPeriod {
        if kind == .year { return SpendingPeriod(kind: .year, year: year + 1, month: month) }
        return month == 12 ? SpendingPeriod(kind: .month, year: year + 1, month: 1) : SpendingPeriod(kind: .month, year: year, month: month + 1)
    }

    public func canGoNext(today: String) -> Bool {
        let now = SpendingPeriod.current(today: today)
        return kind == .year ? year < now.year : (year, month) < (now.year, now.month)
    }

    public var queryItems: [URLQueryItem] {
        let date = kind == .year ? String(year) : String(format: "%04d-%02d", year, month)
        return [URLQueryItem(name: "period", value: kind.rawValue), URLQueryItem(name: "date", value: date)]
    }

    public var title: String { kind == .year ? String(year) : "\(Self.monthNames[month - 1]) \(year)" }
}
