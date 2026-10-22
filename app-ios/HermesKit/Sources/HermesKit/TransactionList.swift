public extension Array where Element: Identifiable {
    /// Keep the loaded copy when a date edit makes a later page repeat a row.
    func appendingPage(_ page: [Element]) -> [Element] {
        // shortcut: unseen rows moved ahead of a cursor need a refresh; add cursor revisions if automatic recovery is required.
        var ids = Set(map(\.id))
        return self + page.filter { ids.insert($0.id).inserted }
    }
}

public extension Array where Element == LedgerTransaction {
    /// A moved row stays within the loaded window, or anywhere when all rows are loaded.
    mutating func refreshTransaction(_ fresh: LedgerTransaction, allLoaded: Bool) {
        guard let index = firstIndex(where: { $0.id == fresh.id }), let boundary = last else { return }
        if self[index].date == fresh.date { self[index] = fresh; return }
        remove(at: index)
        guard allLoaded || fresh.date > boundary.date || (fresh.date == boundary.date && fresh.id >= boundary.id) else { return }
        let position = firstIndex { $0.date < fresh.date || ($0.date == fresh.date && $0.id < fresh.id) } ?? endIndex
        insert(fresh, at: position)
    }
}
