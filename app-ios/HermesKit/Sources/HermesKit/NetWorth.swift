import Foundation

public struct NetWorthPoint: Decodable, Sendable, Hashable {
    public let date: String
    public let netWorthCents: Int
}

/// One point per day; each account's latest balance carries forward. Days through `estimatedThrough` are estimated from transactions.
public struct NetWorthHistory: Decodable, Sendable {
    public let points: [NetWorthPoint]
    public let currentCents: Int
    public let changeCents: Int
    public let estimatedThrough: String?

    /// Change over the range as a fraction, or nil when the range starts at or below zero.
    public var changePercent: Double? { Investments.percent(changeCents, of: points.first?.netWorthCents) }
}

public enum NetWorthRange: String, CaseIterable, Sendable, Hashable {
    case month = "1m", quarter = "3m", year = "1y", all

    public var title: String {
        switch self {
        case .month: "1M"
        case .quarter: "3M"
        case .year: "1Y"
        case .all: "All"
        }
    }

    public var queryItems: [URLQueryItem] { [URLQueryItem(name: "range", value: rawValue)] }
}
