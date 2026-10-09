import HermesKit
import SwiftUI

struct TransactionRow: View {
    @Environment(AppModel.self) private var model
    let transaction: LedgerTransaction

    var body: some View {
        ListRow(title: transaction.payee, subtitle: subtitle) {
            MoneyText(cents: transaction.amountCents)
        }
    }

    private var subtitle: String {
        let tag = transaction.splitLines.isEmpty
            ? model.tagLabel(personId: transaction.personId, categoryId: transaction.categoryId, amountCents: transaction.amountCents)
            : "Split"
        return [DayText.display(transaction.date), tag, transaction.pending ? "Pending" : nil].compactMap { $0 }.joined(separator: " · ")
    }
}
