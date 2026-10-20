import Foundation

public struct RecurringItem: Codable, Sendable, Identifiable {
    public let id: String
    /// "plaid" or "manual"
    public let source: String
    public let name: String
    public let frequency: String
    public let amountCents: Int
    public let variable: Bool
    public let lastDate: String
    public let lastCents: Int
    public let nextDate: String?
    public let monthlyCents: Int?
    public let priceUpCents: Int
    public let isNew: Bool
    public let hidden: Bool
    /// Two charges missed, or marked cancelled. nil from servers before 1.8.1 (183).
    public let ended: Bool?
    /// Marked cancelled by the owner (one way to be ended). nil from servers before 1.8.1 (183).
    public let cancelled: Bool?
    /// Plaid stopped tracking the stream (one way to be ended). nil, read as false, from servers before 1.8.1 (183).
    public let stopped: Bool?
}

public struct RecurringList: Codable, Sendable {
    public let upcoming: [RecurringItem]
    public let items: [RecurringItem]
    public let monthlyTotalCents: Int
    public let dueThisWeek: Int
}

/// nil fields are omitted, so they stay unchanged on the server.
public struct PatchRecurringBody: Codable, Sendable {
    public var hidden: Bool?
    public var name: String?
    public var frequency: String?
    public var ended: Bool?

    public init(hidden: Bool? = nil, name: String? = nil, frequency: String? = nil, ended: Bool? = nil) {
        self.hidden = hidden
        self.name = name
        self.frequency = frequency
        self.ended = ended
    }
}

public struct CreateRecurringBody: Codable, Sendable {
    public let transactionId: String
    public let frequency: String
    public let name: String?

    public init(transactionId: String, frequency: String, name: String?) {
        self.transactionId = transactionId
        self.frequency = frequency
        self.name = name
    }
}
