import Foundation

/// `.unchanged` omits the key; `.set(nil)` sends JSON null (clears the field).
public enum FieldUpdate<Value: Encodable & Sendable & Equatable>: Sendable, Equatable {
    case unchanged
    case set(Value?)
}

public struct PatchTransactionBody: Encodable, Sendable, Equatable {
    public var categoryId: FieldUpdate<String>
    public var payee: FieldUpdate<String>
    public var notes: FieldUpdate<String>

    public init(categoryId: FieldUpdate<String> = .unchanged, payee: FieldUpdate<String> = .unchanged, notes: FieldUpdate<String> = .unchanged) {
        self.categoryId = categoryId
        self.payee = payee
        self.notes = notes
    }

    public var isEmpty: Bool { categoryId == .unchanged && payee == .unchanged && notes == .unchanged }

    private enum Keys: String, CodingKey { case categoryId, payee, notes }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        for (key, update) in [(Keys.categoryId, categoryId), (.payee, payee), (.notes, notes)] {
            guard case .set(let value) = update else { continue }
            if let value { try container.encode(value, forKey: key) } else { try container.encodeNil(forKey: key) }
        }
    }
}

public struct CreateTransactionBody: Encodable, Sendable, Equatable {
    public let accountId: String
    public let date: String
    public let amountCents: Int
    public let payee: String
    public let categoryId: String?
    public let notes: String?

    public init(accountId: String, date: String, amountCents: Int, payee: String, categoryId: String?, notes: String?) {
        self.accountId = accountId
        self.date = date
        self.amountCents = amountCents
        self.payee = payee
        self.categoryId = categoryId
        self.notes = notes
    }
}

public enum LinkSessionBody: Encodable, Sendable, Equatable {
    case create
    case update(itemId: String)

    private enum Keys: String, CodingKey { case mode, itemId }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .create:
            try container.encode("create", forKey: .mode)
        case .update(let itemId):
            try container.encode("update", forKey: .mode)
            try container.encode(itemId, forKey: .itemId)
        }
    }
}

public struct AppleCardImportBody: Encodable, Sendable, Equatable {
    public let csv: String
    public init(csv: String) { self.csv = csv }
}
