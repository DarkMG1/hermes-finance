/// Payback picker math: an exact-amount item first and pre-ticked; ticked items filled oldest first up to the payback.
public enum PaybackFill {
    public static func ordered(_ items: [OpenItem], paybackCents: Int) -> [OpenItem] {
        guard let i = items.firstIndex(where: { $0.leftCents == paybackCents }) else { return items }
        var rest = items
        return [rest.remove(at: i)] + rest
    }

    public static func preselected(_ items: [OpenItem], paybackCents: Int) -> Set<String> {
        items.first { $0.leftCents == paybackCents }.map { [$0.id] } ?? []
    }

    /// items arrive oldest first from the server
    public static func amounts(_ items: [OpenItem], selected: Set<String>, paybackCents: Int) -> [PaybackItem] {
        var rest = paybackCents
        return items.filter { selected.contains($0.id) }.compactMap { item in
            let cents = min(item.leftCents, rest)
            rest -= cents
            return cents > 0 ? PaybackItem(transactionId: item.transactionId, lineId: item.lineId, amountCents: cents) : nil
        }
    }
}
