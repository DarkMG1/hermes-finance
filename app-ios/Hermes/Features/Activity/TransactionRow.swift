import HermesKit
import SwiftUI

struct TransactionRow: View {
    @Environment(AppModel.self) private var model
    let transaction: LedgerTransaction

    var body: some View {
        ListRow(title: transaction.payee, subtitle: subtitle) {
            if transaction.hasReceipt == true {
                Image(systemName: "doc.text")
                    .textStyle(.caption, color: Palette.secondaryText)
                    .accessibilityLabel("Has receipt")
            }
            MoneyText(cents: transaction.amountCents)
        }
    }

    private var subtitle: String {
        var tag = transaction.splitLines.isEmpty
            ? model.tagLabel(personId: transaction.personId, categoryId: transaction.categoryId, amountCents: transaction.amountCents)
            : "Split"
        if let payer = transaction.paidByPersonId { tag += " · Paid by \(model.personName(payer))" }
        return [DayText.display(transaction.date), tag, transaction.pending ? "Pending" : nil].compactMap { $0 }.joined(separator: " · ")
    }
}
