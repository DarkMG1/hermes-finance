/// Row wording shared by transactions and their split lines; the app resolves display dates and names.
public enum TransactionLabel {
    public static func tag(personName: String?, categoryName: String, amountCents: Int, iou: TransactionIOU? = nil) -> String {
        guard let personName else { return categoryName }
        guard amountCents < 0 else {
            let paid = iou?.paidBack ?? []
            if paid.count > 1 { return "\(personName) repaid · \(paid.count) items" }
            return paid.first.map { "\(personName) repaid · \($0.payee ?? "")" } ?? "\(personName) repaid"
        }
        guard let left = iou?.leftCents else { return "\(personName) owes" }
        if left == 0 { return "\(personName) repaid" }
        return left < -amountCents ? "\(personName) owes · \(Money.format(left)) left" : "\(personName) owes"
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
                             amountCents: transaction.amountCents, iou: transaction.iou))
        }
        return parts.joined(separator: " · ")
    }
}
