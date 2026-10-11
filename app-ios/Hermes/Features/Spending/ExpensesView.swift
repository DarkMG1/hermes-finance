import HermesKit
import SwiftUI

/// The rows behind one Spending number: all expenses, one category, or income. Each of your split lines is its own row.
struct ExpensesView: View {
    @Environment(AppModel.self) private var model
    let title: String
    let query: ExpensesQuery
    /// Spending's totals change too after an edit.
    let onChange: () async -> Void

    @State private var rows: [ExpenseRow] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var lastLoad: Loaded<ExpensesPage>?
    @State private var generation = 0
    @State private var opened: Opened?

    private enum Opened: Identifiable {
        case transaction(LedgerTransaction)
        case line(LedgerTransaction, String)
        case split(LedgerTransaction)

        var id: String {
            switch self {
            case .transaction(let transaction): "t/\(transaction.id)"
            case .line(let transaction, let lineId): "l/\(transaction.id)/\(lineId)"
            case .split(let transaction): "s/\(transaction.id)"
            }
        }
    }

    var body: some View {
        List {
            Group {
                Text(query.period.title).textStyle(.subhead, color: Palette.secondaryText)
                if let lastLoad { LastUpdated(loaded: lastLoad) }
                InlineError(message: error)
                ForEach(rows) { row in
                    Button { Task { await open(row) } } label: {
                        ListRow(title: row.name, subtitle: subtitle(row)) { MoneyText(cents: row.amountCents, colored: false) }
                    }
                    .buttonStyle(.plain)
                    .onAppear {
                        if row.id == rows.last?.id, cursor != nil { Task { await load(reset: false) } }
                    }
                }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if !loading && rows.isEmpty && error == nil {
                    Text("Nothing in this period").textStyle(.subhead, color: Palette.secondaryText)
                }
                // every page is loaded, so this equals the number tapped on Spending
                if !loading && cursor == nil && !rows.isEmpty {
                    LabeledContent("Total") { MoneyText(cents: rows.reduce(0) { $0 + $1.amountCents }, colored: false) }
                }
            }
            .listRowBackground(Palette.surface)
        }
        .themedForm()
        .navigationTitle(title)
        .task { await load(reset: true) }
        .refreshable { await load(reset: true) }
        .sheet(item: $opened) { opened in
            switch opened {
            case .transaction(let transaction): TransactionDetailSheet(transaction: transaction) { await changed() }
            case .line(let transaction, let lineId): SplitLineSheet(transaction: transaction, lineId: lineId) { await changed() }
            case .split(let transaction): SplitSheet(transaction: transaction) { await changed() }
            }
        }
    }

    private func subtitle(_ row: ExpenseRow) -> String {
        let tag = row.isSplitDifference ? "Split difference" : row.categoryName
        return [DayText.display(row.date), tag, row.isSplit ? "Split" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    private func changed() async {
        await load(reset: true)
        await onChange()
    }

    /// Rows carry ids only, so the transaction is read fresh; a split difference opens the split editor to fix it.
    private func open(_ row: ExpenseRow) async {
        guard let reader = model.reader else { return }
        do {
            let transaction = try await reader.read("/v1/transactions/\(row.transactionId)", as: LedgerTransaction.self).value
            if row.isSplitDifference {
                opened = .split(transaction)
            } else if let lineId = row.lineId {
                opened = .line(transaction, lineId)
            } else {
                opened = .transaction(transaction)
            }
        } catch ClientError.api(status: 404, _) {
            await load(reset: true)
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func load(reset: Bool) async {
        guard let reader = model.reader, reset || !loading else { return }
        if reset { generation += 1 }
        let gen = generation
        loading = true
        defer { if gen == generation { loading = false } }
        var request = query
        request.cursor = reset ? nil : cursor
        do {
            let page = try await reader.read("/v1/expenses", query: request.items, as: ExpensesPage.self)
            guard gen == generation, !Task.isCancelled else { return }
            rows = reset ? page.value.rows : rows + page.value.rows
            cursor = page.value.nextCursor
            lastLoad = page
            error = nil
        } catch {
            guard gen == generation, !Task.isCancelled else { return }
            self.error = errorMessage(error)
        }
    }
}
