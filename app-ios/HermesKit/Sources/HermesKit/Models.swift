import Foundation

public struct Account: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let mask: String?
    public let type: String
    public let subtype: String?
    public let balanceCurrentCents: Int?
    public let balanceAvailableCents: Int?
    public let balanceAt: String?
    public let hidden: Bool
    public let itemId: String?
}

public struct Category: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let groupName: String
    public let isIncome: Bool
    public let isTransfer: Bool
    public let hidden: Bool

    public init(id: String, name: String, groupName: String, isIncome: Bool = false, isTransfer: Bool = false, hidden: Bool = false) {
        self.id = id
        self.name = name
        self.groupName = groupName
        self.isIncome = isIncome
        self.isTransfer = isTransfer
        self.hidden = hidden
    }
}

public struct SplitLine: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let amountCents: Int
    public let categoryId: String?
    public let notes: String?
}

public struct LedgerTransaction: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let accountId: String
    public let source: String
    public let date: String
    public let amountCents: Int
    public let payee: String
    public let bankDescription: String
    public let merchantName: String?
    public let pending: Bool
    public let categoryId: String?
    public let notes: String?
    public let splitLines: [SplitLine]
}

public struct TransactionPage: Codable, Sendable {
    public let transactions: [LedgerTransaction]
    public let nextCursor: String?
}

public struct ReconnectItem: Codable, Sendable, Identifiable, Hashable {
    public let itemId: String
    public let institutionName: String
    public var id: String { itemId }
}

public struct Home: Codable, Sendable {
    public let netWorthCents: Int
    public let recent: [LedgerTransaction]
    public let reconnect: [ReconnectItem]
}

public struct SpendingCategory: Codable, Sendable, Hashable {
    public let categoryId: String?
    public let name: String
    public let spentCents: Int
}

public struct Spending: Codable, Sendable {
    public let from: String
    public let toExclusive: String
    public let totalCents: Int
    public let categories: [SpendingCategory]
}

public struct Bank: Codable, Sendable, Identifiable, Hashable {
    public let itemId: String
    public let institutionName: String
    public let status: String
    public let lastSyncedAt: String?
    public let lastErrorCode: String?
    public var id: String { itemId }
}

public struct LinkSession: Codable, Sendable {
    public let sessionId: String
    public let url: String
    public let expiresAt: String
}

public struct SyncItem: Codable, Sendable, Hashable {
    public let itemId: String
    public let institutionName: String
    public let result: String
    public let added: Int
    public let modified: Int
    public let removed: Int
}

public struct SyncStatus: Codable, Sendable {
    public let items: [SyncItem]
}

public struct Health: Codable, Sendable {
    public let ok: Bool
    public let gitSha: String
    public let dbVersion: Int
}

public struct AppleCardImportResult: Codable, Sendable {
    public let accountId: String
    public let rows: Int
    public let added: Int
    public let updated: Int
    public let skippedBeforeCutover: Int
}

public struct APIErrorBody: Codable, Sendable, Equatable {
    public let code: String
    public let message: String
    public let field: String?

    public init(code: String, message: String, field: String? = nil) {
        self.code = code
        self.message = message
        self.field = field
    }
}
