/// Row wording shared by transactions and their split lines; the app resolves display dates and names.
public enum TransactionLabel {
    public static func tag(personName: String?, categoryName: String, amountCents: Int) -> String {
        guard let personName else { return categoryName }
        return "\(personName) \(amountCents < 0 ? "owes" : "repaid")"
    }

    public static func subtitle(_ transaction: LedgerTransaction, day: String, categoryName: String,
                                personName: (String) -> String) -> String {
        var parts = [day]
        if transaction.pending { parts.append("Pending") }
        if transaction.forgiven == true {
            parts.append("Forgiven")
        } else if let payer = transaction.paidByPersonId {
            parts.append("Paid by \(personName(payer))")
            parts.append("yours \(Money.format(abs(transaction.amountCents)))")
        } else if !transaction.splitLines.isEmpty {
            let people = Set(transaction.splitLines.compactMap(\.personId))
            if let person = people.first, people.count == 1 {
                parts.append("Split with \(personName(person))")
            } else {
                parts.append(people.isEmpty ? "Split" : "Split · \(people.count) people")
            }
            let yours = transaction.splitLines.filter { $0.personId == nil }.reduce(0) { $0 + $1.amountCents }
            if yours != transaction.amountCents { parts.append("yours \(Money.format(abs(yours)))") }
        } else {
            parts.append(tag(personName: transaction.personId.map(personName), categoryName: categoryName,
                             amountCents: transaction.amountCents))
        }
        return parts.joined(separator: " · ")
    }
}
