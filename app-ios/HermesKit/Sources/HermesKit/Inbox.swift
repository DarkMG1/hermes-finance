import Foundation

/// A receipt snapped before its bank charge arrived.
public struct InboxReceipt: Codable, Sendable, Identifiable {
    public let id: String
    public let capturedAt: String
    /// "reading", "read" or "failed"
    public let status: String
    public let merchant: String?
    public let purchaseDate: String?
    public let totalCents: Int?
    /// Items were tagged in the inbox; linking applies them as the split.
    public let tagged: Bool
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
