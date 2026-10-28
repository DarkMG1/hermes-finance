/// A receipt snapped before its bank charge arrived.
public struct InboxReceipt: Codable, Sendable, Identifiable {
    public let id: String
    public let capturedAt: String
    /// "reading", "read" or "failed"
    public let status: String
    public let merchant: String?
    public let purchaseDate: String?
    public let totalCents: Int?
    /// Items were tagged in the inbox; linking applies them unless the whole charge is for someone.
    public let tagged: Bool
    public let forPersonId: String?
    /// The payee name already used for this store ("Acme" for "Acme Wholesale"), else `merchant`.
    public let payee: String?
    public let suggestions: [LedgerTransaction]
}

public struct LinkedReceipt: Codable, Sendable, Identifiable {
    public let id: String
    public let transactionId: String
    public let merchant: String?
    public let totalCents: Int?
    public let linkedAt: String
    public let splitApplied: Bool
}

public struct InboxList: Codable, Sendable {
    public let waiting: [InboxReceipt]
    public let recentlyLinked: [LinkedReceipt]
}

struct LinkInboxBody: Encodable { let transactionId: String }

public struct InboxForBody: Encodable, Sendable {
    public let personId: String?
    public init(personId: String?) { self.personId = personId }
    private enum CodingKeys: String, CodingKey { case personId }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(personId, forKey: .personId)
    }
}

public struct PendingReceiptLink: Sendable {
    public var unlinked: LedgerTransaction?
    /// A definitive link rejection must not strand an already-created expense.
    public var createdPayment: LedgerTransaction?
    public var target: LedgerTransaction? { unlinked ?? createdPayment }

    public init() {}

    public func allows(_ transactionId: String) -> Bool { target.map { $0.id == transactionId } ?? true }
}
