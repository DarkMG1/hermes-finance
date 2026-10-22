import HermesKit
import SwiftUI

/// Pick an expense to share: money out that isn't already split, tagged to someone or paid by someone else.
struct ExpensePicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var title = "Add existing expense"
    /// Shown above the search results while the search box is empty.
    var suggestions: [LedgerTransaction] = []
    /// Which rows can be picked; the default is the existing "shareable" rule.
    var allows: ((LedgerTransaction) -> Bool)?
    let onPick: (LedgerTransaction) -> Void

    @State private var query = ""
    @State private var items: [LedgerTransaction] = []
    @State private var paging = PageCursor<String>()
    @State private var loading = false
    @State private var error: String?
    @State private var generation = 0

    var body: some View {
        NavigationStack {
            List {
                InlineError(message: error)
                if query.isEmpty && !suggestions.isEmpty { Section("Suggested") { ForEach(suggestions) { pickRow($0) } } }
                ForEach(shareableItems) { pickRow($0) }
                // a button, not load-on-scroll: a page can be entirely filtered out, leaving no row to trigger the next one
                if cursor != nil && !loading { Button("Load more") { Task { await load(reset: false) } } }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if !loading && cursor == nil && shareableItems.isEmpty && error == nil {
                    Text(allows == nil ? "No expenses to share" : "No matching transactions").textStyle(.subhead, color: Palette.secondaryText)
                }
            }
            .themedForm()
            .navigationTitle(title)
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

    private var cursor: String? { paging.next(for: query) }

    private var shareableItems: [LedgerTransaction] {
        items.filter { t in (allows ?? shareable)(t) && !(query.isEmpty && suggestions.contains { $0.id == t.id }) }
    }

    private func pickRow(_ transaction: LedgerTransaction) -> some View {
        Button { onPick(transaction); dismiss() } label: { TransactionRow(transaction: transaction) }
            .buttonStyle(.plain)
    }

    private func shareable(_ transaction: LedgerTransaction) -> Bool {
        transaction.amountCents < 0 && transaction.splitLines.isEmpty && transaction.personId == nil && transaction.paidByPersonId == nil
            && model.categories.first { $0.id == transaction.categoryId }?.isTransfer != true
    }

    private func load(reset: Bool) async {
        guard let reader = model.reader, reset || (!loading && cursor != nil) else { return }
        if reset { generation += 1; items = []; paging.reset() }
        let gen = generation
        let requested = query
        loading = true
        defer { if gen == generation { loading = false } }
        let request = TransactionQuery(q: query, cursor: reset ? nil : cursor)
        do {
            let page = try await reader.read("/v1/transactions", query: request.items, as: TransactionPage.self)
            guard gen == generation, requested == query, !Task.isCancelled else { return }
            items = (reset ? [] : items).appendingPage(page.value.transactions)
            paging.didLoad(requested, nextCursor: page.value.nextCursor)
            error = nil
        } catch {
            guard gen == generation, requested == query, !Task.isCancelled else { return }
            self.error = errorMessage(error)
        }
    }
}
