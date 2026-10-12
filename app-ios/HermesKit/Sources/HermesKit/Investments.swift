import Foundation

public struct HoldingAccount: Decodable, Sendable, Hashable, Identifiable {
    public let accountId: String
    public let accountName: String
    public let quantity: Double
    public let valueCents: Int
    public let costBasisCents: Int?
    public var id: String { accountId }
}

/// One holding combined across accounts; all cash is one holding keyed `cashKey`, with no price.
public struct Holding: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let name: String
    public let ticker: String?
    public let type: String?
    public let quantity: Double
    public let priceCents: Int?
    public let valueCents: Int
    public let costBasisCents: Int?
    public let gainCents: Int?
    public let accounts: [HoldingAccount]
    public var id: String { key }

    /// No ticker has an underscore, so a security whose ticker is "CASH" stays apart.
    public static let cashKey = "_cash"
    public var isCash: Bool { key == Holding.cashKey }
    public var gainPercent: Double? { Investments.percent(gainCents, of: costBasisCents) }
    /// For `/v1/investments/holding-history`, with the range's items appended; a query keeps a key with "/" intact.
    public var historyQuery: [URLQueryItem] { [URLQueryItem(name: "key", value: key)] }
}

public struct Investments: Decodable, Sendable {
    public let totalCents: Int
    public let costBasisCents: Int?
    public let gainCents: Int?
    public let asOf: String?
    public let holdings: [Holding]
    public let reconnect: [ReconnectItem]

    public var gainPercent: Double? { Self.percent(gainCents, of: costBasisCents) }

    static func percent(_ gain: Int?, of cost: Int?) -> Double? {
        guard let gain, let cost, cost > 0 else { return nil }
        return Double(gain) / Double(cost)
    }
}

/// The Investments screen's account chips: no selection means every account.
public enum InvestmentFilter {
    public static func queryItems(_ accountIds: Set<String>) -> [URLQueryItem] {
        accountIds.isEmpty ? [] : [URLQueryItem(name: "accountIds", value: accountIds.sorted().joined(separator: ","))]
    }
}
