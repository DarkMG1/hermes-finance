import Foundation

public struct HoldingAccount: Decodable, Sendable, Hashable, Identifiable {
    public let accountId: String
    public let accountName: String
    public let quantity: Double
    public let valueCents: Int
    public let costBasisCents: Int?
    public var id: String { accountId }
}

/// One holding combined across accounts; all cash is one "CASH" holding with no price.
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

    public var gainPercent: Double? { Investments.percent(gainCents, of: costBasisCents) }
    public var historyPath: String { "/v1/investments/holdings/\(key)/history" }
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
