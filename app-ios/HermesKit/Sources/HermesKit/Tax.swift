import Foundation

// Tax projection (v2.3). Every field a newer server added is optional so an older server's payload still decodes.

public struct TaxInputsBody: Codable, Sendable, Equatable {
    public var tuitionCents: Int?
    public var scholarshipsCents: Int?
    public var studentLoanInterestCents: Int?
    public var k401Cents: Int?
    public init() {}
}

/// A year's inputs; saving replaces them, a left-out field becoming null.
public struct TaxInputs: Decodable, Sendable, Equatable {
    public let year: Int
    public let updatedAt: String?
    public let fields: TaxInputsBody

    private enum Keys: String, CodingKey { case year, updatedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        year = try c.decode(Int.self, forKey: .year)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        fields = try TaxInputsBody(from: decoder)
    }
}

public struct TaxScenarioBody: Codable, Sendable, Equatable {
    public var moveDate: String?
    public var moveTo: String?
    public var relocationCents: Int?
    public var bonusCents: Int?
    public var k401Cents: Int?
    public var rothCents: Int?
    public init() {}
}

/// A year's what-if scenario; saving replaces it, a left-out field becoming null.
public struct TaxScenario: Decodable, Sendable, Equatable {
    public let year: Int
    public let updatedAt: String?
    public let fields: TaxScenarioBody

    private enum Keys: String, CodingKey { case year, updatedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        year = try c.decode(Int.self, forKey: .year)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        fields = try TaxScenarioBody(from: decoder)
    }
}

public struct RothContribution: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let date: String
    public let amountCents: Int
    public let taxYear: Int
    public let transactionId: String?
}

public struct RothContributionBody: Codable, Sendable, Equatable {
    public var date: String
    public var amountCents: Int
    public var taxYear: Int
    public init(date: String, amountCents: Int, taxYear: Int) { (self.date, self.amountCents, self.taxYear) = (date, amountCents, taxYear) }
}

public struct TaxLot: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let accountId: String
    public let securityId: String
    public let ticker: String?
    public let acquiredOn: String?
    public let quantity: Double
    public let costCents: Int
    /// known, entered or unverified
    public let status: String
}

public struct TaxSale: Decodable, Sendable, Equatable {
    public let accountId: String
    public let securityId: String
    public let date: String
    public let quantity: Double
    public let proceedsCents: Int
    public let costCents: Int
    public let acquiredOn: String?
    /// short, long or unknown
    public let term: String
    public let washDisallowedCents: Int
    public let taxable: Bool
    /// a proposed short-term sale: the day it would turn long-term
    public let longTermOn: String?
}

/// Shares held before the history that past sales took: their date and cost are still unknown.
public struct TaxUnresolvedShares: Decodable, Sendable, Equatable {
    public let accountId: String
    public let securityId: String
    public let ticker: String?
    public let quantity: Double
}

public struct TaxLots: Decodable, Sendable, Equatable {
    public let lots: [TaxLot]
    public let sales: [TaxSale]
    /// per account: fifo, hifo or specific
    public let methods: [String: String]
    /// per account: true when the method is inferred from the holding's cost basis
    public let inferred: [String: Bool]
    /// per account: false when no method matched the cost basis and FIFO is the default
    public let basisMatched: [String: Bool]
    public let unresolved: [TaxUnresolvedShares]

    private enum Keys: String, CodingKey { case lots, sales, methods, inferred, basisMatched, unresolved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        lots = try c.decode([TaxLot].self, forKey: .lots)
        sales = try c.decode([TaxSale].self, forKey: .sales)
        methods = try c.decode([String: String].self, forKey: .methods)
        inferred = try c.decode([String: Bool].self, forKey: .inferred)
        basisMatched = try c.decodeIfPresent([String: Bool].self, forKey: .basisMatched) ?? [:]
        unresolved = try c.decodeIfPresent([TaxUnresolvedShares].self, forKey: .unresolved) ?? []
    }
}

/// A lot for shares held before the investment history.
public struct TaxLotBody: Codable, Sendable, Equatable {
    public var accountId: String
    public var securityId: String
    public var acquiredOn: String
    public var quantity: Double
    public var costCents: Int
    public init(accountId: String, securityId: String, acquiredOn: String, quantity: Double, costCents: Int) {
        (self.accountId, self.securityId, self.acquiredOn, self.quantity, self.costCents) = (accountId, securityId, acquiredOn, quantity, costCents)
    }
}

public struct TaxLine: Decodable, Sendable, Equatable {
    public let key: String
    public let label: String
    public let cents: Int
    public let source: String
    public let assumption: String?
}

public struct TaxReturnResult: Decodable, Sendable, Equatable {
    public struct Carryover: Decodable, Sendable, Equatable {
        public let shortCents: Int
        public let longCents: Int
    }

    public let jurisdiction: String
    public let supported: Bool
    public let lines: [TaxLine]
    public let taxCents: Int
    public let withheldCents: Int
    public let balanceCents: Int
    public let safeHarborCents: Int?
    public let unusedCarryover: Carryover?
}

public struct TaxAdvice: Decodable, Sendable, Equatable {
    public let kind: String
    public let title: String
    public let detail: String
    public let savingsCents: Int?
    public let dueDate: String?
    public let askPrompt: String
}

public struct TaxProjection: Decodable, Sendable, Equatable {
    public struct Figures: Decodable, Sendable, Equatable {
        public let federalYear: Int
        public let fallback: Bool
    }

    public let year: Int
    public let openYears: [Int]
    public let asOf: String
    /// false when a return's tax isn't in the combined result
    public let complete: Bool
    public let combinedBalanceCents: Int
    public let returns: [TaxReturnResult]
    public let assumptions: [String]
    public let figures: Figures
    public let waysToSave: [TaxAdvice]
    public let headsUp: [TaxAdvice]

    private enum Keys: String, CodingKey { case year, openYears, asOf, complete, combinedBalanceCents, returns, assumptions, figures, waysToSave, headsUp }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        year = try c.decode(Int.self, forKey: .year)
        openYears = try c.decode([Int].self, forKey: .openYears)
        asOf = try c.decode(String.self, forKey: .asOf)
        complete = try c.decodeIfPresent(Bool.self, forKey: .complete) ?? true
        combinedBalanceCents = try c.decode(Int.self, forKey: .combinedBalanceCents)
        returns = try c.decode([TaxReturnResult].self, forKey: .returns)
        assumptions = try c.decode([String].self, forKey: .assumptions)
        figures = try c.decode(Figures.self, forKey: .figures)
        waysToSave = try c.decode([TaxAdvice].self, forKey: .waysToSave)
        headsUp = try c.decodeIfPresent([TaxAdvice].self, forKey: .headsUp) ?? []
    }

    /// Why the combined result leaves something out: the assumptions that say so.
    public var incompleteReason: String? {
        guard !complete else { return nil }
        let notes = assumptions.filter { $0.contains("isn't in the total") }
        return notes.isEmpty ? "a return's tax isn't in the total" : notes.joined(separator: "; ")
    }

    /// The federal return's withholding against its safe harbor, when the server knows one.
    public var meetsSafeHarbor: Bool? {
        guard let federal = returns.first(where: { $0.jurisdiction == "federal" }), let harbor = federal.safeHarborCents else { return nil }
        return federal.withheldCents >= harbor
    }
}

public struct TaxWhatIfSale: Codable, Sendable, Equatable {
    public var accountId: String
    public var securityId: String
    public var quantity: Double
    public var lotIds: [String]?
    public init(accountId: String, securityId: String, quantity: Double, lotIds: [String]? = nil) {
        (self.accountId, self.securityId, self.quantity, self.lotIds) = (accountId, securityId, quantity, lotIds)
    }
}

public struct TaxWhatIfChange: Codable, Sendable, Equatable {
    public var sell: [TaxWhatIfSale]?
    public var extraWithholdingCents: Int?
    public var scenario: TaxScenarioBody?
    public init(sell: [TaxWhatIfSale]? = nil, extraWithholdingCents: Int? = nil, scenario: TaxScenarioBody? = nil) {
        (self.sell, self.extraWithholdingCents, self.scenario) = (sell, extraWithholdingCents, scenario)
    }
}

public struct TaxWhatIf: Decodable, Sendable, Equatable {
    public let before: TaxProjection
    public let after: TaxProjection
    public let deltaCents: Int
    public let blocked: String?
    public let sales: [TaxSale]
}

/// `items` only come with `unlocked`, so a locked Home gets a count.
public struct TaxHeadsUp: Decodable, Sendable, Equatable {
    public let count: Int
    public let items: [TaxAdvice]?
}

extension APIClient {
    /// No year: the server's first open year.
    public func taxProjection(year: Int?) async throws -> TaxProjection {
        try decode(try await getData("/v1/tax/projection", query: year.map { [URLQueryItem(name: "year", value: String($0))] } ?? []))
    }

    public func taxWhatIf(year: Int, change: TaxWhatIfChange) async throws -> TaxWhatIf {
        struct Body: Encodable { let year: Int; let change: TaxWhatIfChange }
        let data = try JSONEncoder().encode(Body(year: year, change: change))
        return try decode(try await send("POST", "/v1/tax/what-if", body: data, idempotencyKey: nil, timeout: 30).body)
    }

    public func taxHeadsUp(unlocked: Bool) async throws -> TaxHeadsUp {
        try decode(try await getData("/v1/tax/heads-up", query: unlocked ? [URLQueryItem(name: "unlocked", value: "1")] : []))
    }

    public func taxInputs(year: Int) async throws -> TaxInputs { try decode(try await getData("/v1/tax/inputs/\(year)")) }

    public func putTaxInputs(year: Int, _ body: TaxInputsBody, idempotencyKey: String) async throws -> TaxInputs {
        try await write("PUT", "/v1/tax/inputs/\(year)", body: body, key: idempotencyKey)
    }

    public func taxScenario(year: Int) async throws -> TaxScenario { try decode(try await getData("/v1/tax/scenario/\(year)")) }

    public func putTaxScenario(year: Int, _ body: TaxScenarioBody, idempotencyKey: String) async throws -> TaxScenario {
        try await write("PUT", "/v1/tax/scenario/\(year)", body: body, key: idempotencyKey)
    }

    public func rothContributions(taxYear: Int) async throws -> [RothContribution] {
        struct Reply: Decodable { let contributions: [RothContribution] }
        let reply: Reply = try decode(try await getData("/v1/tax/roth-contributions", query: [URLQueryItem(name: "taxYear", value: String(taxYear))]))
        return reply.contributions
    }

    public func addRothContribution(_ body: RothContributionBody, idempotencyKey: String) async throws -> RothContribution {
        try await write("POST", "/v1/tax/roth-contributions", body: body, key: idempotencyKey)
    }

    public func setRothContributionYear(id: String, taxYear: Int, idempotencyKey: String) async throws -> RothContribution {
        try await write("PUT", "/v1/tax/roth-contributions/\(id)", body: ["taxYear": taxYear], key: idempotencyKey)
    }

    public func deleteRothContribution(id: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/tax/roth-contributions/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    public func taxLots() async throws -> TaxLots { try decode(try await getData("/v1/tax/lots")) }

    public func addTaxLot(_ body: TaxLotBody, idempotencyKey: String) async throws {
        try await send("POST", "/v1/tax/lots", body: JSONEncoder().encode(body), idempotencyKey: idempotencyKey, timeout: 30)
    }

    public func deleteTaxLot(id: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/tax/lots/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    /// A nil method goes back to the one inferred from the holding's cost basis.
    public func setLotMethod(accountId: String, method: String?, idempotencyKey: String) async throws {
        let body = try JSONEncoder().encode(["method": method.map(JSONValue.string) ?? .null])
        try await send("PATCH", "/v1/accounts/\(accountId)/lot-method", body: body, idempotencyKey: idempotencyKey, timeout: 30)
    }
}
