import Foundation

public struct ReconcileSummary: Codable, Sendable, Hashable {
    public let month: String
    public let open: Int
}

/// One month's money-out rows still to reconcile, oldest first; `total` counts the ones already done too.
public struct ReconcileList: Codable, Sendable {
    public let month: String
    public let total: Int
    public let open: Int
    public let transactions: [LedgerTransaction]

    public func excludingPendingChecks(_ ids: Set<String>) -> [LedgerTransaction] {
        transactions.filter { !ids.contains($0.id) }
    }
}

public struct ReconcileMonths: Codable, Sendable {
    public let months: [ReconcileSummary]
}

public enum ReconcileMonth {
    public static func openCount(_ month: String, loadedMonth: String?, rows: [LedgerTransaction], summaries: [ReconcileSummary]) -> Int? {
        month == loadedMonth ? rows.count : summaries.first { $0.month == month }?.open
    }

    /// "2026-09" → "September 2026".
    public static func title(_ month: String) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return month }
        return SpendingPeriod(kind: .month, year: parts[0], month: parts[1]).title
    }

    /// "2026-10-12" → "2026-10".
    public static func current(today: String) -> String { String(today.prefix(7)) }

    public static func queryItems(_ month: String) -> [URLQueryItem] { [URLQueryItem(name: "month", value: month)] }
}
