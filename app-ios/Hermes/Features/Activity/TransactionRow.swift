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
        TransactionLabel.subtitle(transaction, day: DayText.display(transaction.date),
                                  categoryName: model.categoryName(transaction.categoryId), personName: model.personName)
    }
}
