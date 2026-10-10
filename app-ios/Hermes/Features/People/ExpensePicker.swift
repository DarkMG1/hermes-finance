import HermesKit
import SwiftUI

/// Pick an expense to share: money out that isn't already split, tagged to someone or paid by someone else.
struct ExpensePicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onPick: (LedgerTransaction) -> Void

    @State private var query = ""
    @State private var items: [LedgerTransaction] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var generation = 0

    var body: some View {
        NavigationStack {
            List {
                InlineError(message: error)
                ForEach(shareableItems) { transaction in
                    Button { onPick(transaction); dismiss() } label: { TransactionRow(transaction: transaction) }
                        .buttonStyle(.plain)
                }
                // a button, not load-on-scroll: a page can be entirely filtered out, leaving no row to trigger the next one
                if cursor != nil && !loading { Button("Load more") { Task { await load(reset: false) } } }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if !loading && cursor == nil && shareableItems.isEmpty && error == nil {
                    Text("No expenses to share").textStyle(.subhead, color: Palette.secondaryText)
                }
            }
            .themedForm()
            .navigationTitle("Add existing expense")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await load(reset: true)
            }
        }
    }

    private var shareableItems: [LedgerTransaction] { items.filter(shareable) }

    private func shareable(_ transaction: LedgerTransaction) -> Bool {
        transaction.amountCents < 0 && transaction.splitLines.isEmpty && transaction.personId == nil && transaction.paidByPersonId == nil
            && model.categories.first { $0.id == transaction.categoryId }?.isTransfer != true
    }

    private func load(reset: Bool) async {
        guard let reader = model.reader, reset || !loading else { return }
        if reset { generation += 1 }
        let gen = generation
        loading = true
        defer { if gen == generation { loading = false } }
        let request = TransactionQuery(q: query, cursor: reset ? nil : cursor)
        do {
            let page = try await reader.read("/v1/transactions", query: request.items, as: TransactionPage.self)
            guard gen == generation, !Task.isCancelled else { return }
            items = reset ? page.value.transactions : items + page.value.transactions
            cursor = page.value.nextCursor
            error = nil
        } catch {
            guard gen == generation, !Task.isCancelled else { return }
            self.error = errorMessage(error)
        }
    }
}
