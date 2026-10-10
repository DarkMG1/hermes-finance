import Foundation

public struct TransactionQuery: Sendable, Equatable {
    public var accountId: String?
    public var categoryId: String?
    public var personId: String?
    public var q: String?
    public var cursor: String?
    public var limit = 50

    public init(accountId: String? = nil, categoryId: String? = nil, q: String? = nil, cursor: String? = nil, personId: String? = nil) {
        self.accountId = accountId
        self.categoryId = categoryId
        self.q = q
        self.personId = personId
        self.cursor = cursor
    }

    public var items: [URLQueryItem] {
        var out: [URLQueryItem] = []
        if let accountId { out.append(URLQueryItem(name: "accountId", value: accountId)) }
        if let categoryId { out.append(URLQueryItem(name: "categoryId", value: categoryId)) }
        if let personId { out.append(URLQueryItem(name: "personId", value: personId)) }
        if let q {
            let trimmed = q.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { out.append(URLQueryItem(name: "q", value: String(trimmed.prefix(100)))) }
        }
        if let cursor { out.append(URLQueryItem(name: "cursor", value: cursor)) }
        out.append(URLQueryItem(name: "limit", value: String(limit)))
        return out
    }
}
