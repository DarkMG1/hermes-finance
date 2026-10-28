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
    /// Distinct tagged people, excluding Me; nil from older servers.
    public let taggedPersonIds: [String]?
    /// The payee name already used for this store ("Acme" for "Acme Wholesale"), else `merchant`.
    public let payee: String?
    public let suggestions: [LedgerTransaction]

    public func subtitle(day: String, personName: (String) -> String) -> String {
        var parts = [day]
        if status == "reading" { parts.append("Reading…") }
        if status == "failed" { parts.append("Couldn't read") }
        if let forPersonId {
            parts.append("For \(personName(forPersonId))")
        } else if tagged {
            if let taggedPersonIds {
                if taggedPersonIds.count == 1 {
                    parts.append("Split with \(personName(taggedPersonIds[0]))")
                } else if taggedPersonIds.count > 1 {
                    parts.append("Split with \(taggedPersonIds.count) people")
                }
            } else {
                parts.append("Split")
            }
        }
        if !suggestions.isEmpty {
            parts.append(suggestions.count == 1 ? "1 suggestion" : "\(suggestions.count) suggestions")
        }
        if parts.count == 1 { parts.append("Waiting for the charge") }
        return parts.joined(separator: " · ")
    }
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
