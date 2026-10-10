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
    /// Setting a person clears the category on the server, and setting a category clears the person.
    public var personId: FieldUpdate<String>
    /// Manual rows only: someone else paid; it stays the owner's spending.
    public var paidByPersonId: FieldUpdate<String>
    public var repaymentDismissed: Bool?

    public init(categoryId: FieldUpdate<String> = .unchanged, payee: FieldUpdate<String> = .unchanged, notes: FieldUpdate<String> = .unchanged,
                personId: FieldUpdate<String> = .unchanged, paidByPersonId: FieldUpdate<String> = .unchanged, repaymentDismissed: Bool? = nil) {
        self.categoryId = categoryId
        self.payee = payee
        self.notes = notes
        self.personId = personId
        self.paidByPersonId = paidByPersonId
        self.repaymentDismissed = repaymentDismissed
    }

    public var isEmpty: Bool {
        categoryId == .unchanged && payee == .unchanged && notes == .unchanged && personId == .unchanged && paidByPersonId == .unchanged
            && repaymentDismissed == nil
    }

    private enum Keys: String, CodingKey { case categoryId, payee, notes, personId, paidByPersonId, repaymentDismissed }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        for (key, update) in [(Keys.categoryId, categoryId), (.payee, payee), (.notes, notes), (.personId, personId), (.paidByPersonId, paidByPersonId)] {
            guard case .set(let value) = update else { continue }
            if let value { try container.encode(value, forKey: key) } else { try container.encodeNil(forKey: key) }
        }
        try container.encodeIfPresent(repaymentDismissed, forKey: .repaymentDismissed)
    }
}

/// `name: nil` sends JSON null: go back to the bank's name.
public struct PatchAccountBody: Encodable, Sendable, Equatable {
    public let name: String?

    public init(name: String?) { self.name = name }

    private enum Keys: String, CodingKey { case name }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        if let name { try container.encode(name, forKey: .name) } else { try container.encodeNil(forKey: .name) }
    }
}

/// One line of a split. `categoryId: nil` sends JSON null (an uncategorized line); nil notes and person are left out.
public struct SplitLineBody: Encodable, Sendable, Equatable {
    public let amountCents: Int
    public let categoryId: String?
    public let notes: String?
    public let personId: String?

    public init(amountCents: Int, categoryId: String?, notes: String?, personId: String? = nil) {
        self.amountCents = amountCents
        self.categoryId = categoryId
        self.notes = notes
        self.personId = personId
    }

    private enum Keys: String, CodingKey { case amountCents, categoryId, notes, personId }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(amountCents, forKey: .amountCents)
        if let categoryId { try container.encode(categoryId, forKey: .categoryId) } else { try container.encodeNil(forKey: .categoryId) }
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encodeIfPresent(personId, forKey: .personId)
    }
}

/// Replaces a transaction's split lines; no lines removes the split.
public struct PutSplitsBody: Encodable, Sendable, Equatable {
    public let lines: [SplitLineBody]

    public init(lines: [SplitLineBody]) { self.lines = lines }
}

/// Always lands in the server's hidden manual account; bank-fed accounts only change by sync or import.
public struct CreateTransactionBody: Encodable, Sendable, Equatable {
    public let date: String
    public let amountCents: Int
    public let payee: String
    public let categoryId: String?
    public let notes: String?
    /// Someone else paid this; the amount is the owner's share.
    public let paidByPersonId: String?
    /// Saved already split; the category then lives on the lines.
    public let splitLines: [SplitLineBody]?

    public init(date: String, amountCents: Int, payee: String, categoryId: String?, notes: String?, paidByPersonId: String? = nil,
                splitLines: [SplitLineBody]? = nil) {
        self.date = date
        self.amountCents = amountCents
        self.payee = payee
        self.categoryId = categoryId
        self.notes = notes
        self.paidByPersonId = paidByPersonId
        self.splitLines = splitLines
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

public struct CreatePersonBody: Encodable, Sendable, Equatable {
    public let name: String
    public let matchText: String?

    public init(name: String, matchText: String?) {
        self.name = name
        self.matchText = matchText
    }
}

/// Only the fields given are sent; `matchText: .set(nil)` clears it.
public struct PatchPersonBody: Encodable, Sendable, Equatable {
    public var name: String?
    public var matchText: FieldUpdate<String>
    public var archived: Bool?

    public init(name: String? = nil, matchText: FieldUpdate<String> = .unchanged, archived: Bool? = nil) {
        self.name = name
        self.matchText = matchText
        self.archived = archived
    }

    private enum Keys: String, CodingKey { case name, matchText, archived }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encodeIfPresent(name, forKey: .name)
        if case .set(let value) = matchText {
            if let value { try container.encode(value, forKey: .matchText) } else { try container.encodeNil(forKey: .matchText) }
        }
        try container.encodeIfPresent(archived, forKey: .archived)
    }
}
