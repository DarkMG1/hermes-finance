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
        let category = transaction.splitLines.isEmpty ? model.categoryName(transaction.categoryId) : "Split"
        return [DayText.display(transaction.date), category, transaction.pending ? "Pending" : nil].compactMap { $0 }.joined(separator: " · ")
    }
}
