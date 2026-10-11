import Foundation

/// The rows behind one Spending number: all expenses, one category, or income, for a period.
public struct ExpensesQuery: Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable { case out, `in` }

    /// The Uncategorized bucket, which has no category id.
    public static let uncategorized = "uncategorized"

    public var period: SpendingPeriod
    public var kind: Kind
    public var categoryId: String?
    public var cursor: String?
    public var limit = 50

    public init(period: SpendingPeriod, kind: Kind, categoryId: String? = nil, cursor: String? = nil) {
        self.period = period
        self.kind = kind
        self.categoryId = categoryId
        self.cursor = cursor
    }

    public var items: [URLQueryItem] {
        var out = period.queryItems
        out.append(URLQueryItem(name: "kind", value: kind.rawValue))
        if let categoryId { out.append(URLQueryItem(name: "categoryId", value: categoryId)) }
        if let cursor { out.append(URLQueryItem(name: "cursor", value: cursor)) }
        out.append(URLQueryItem(name: "limit", value: String(limit)))
        return out
    }
}
