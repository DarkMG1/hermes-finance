import Charts
import HermesKit
import SwiftUI

/// One payee's spending: twelve monthly bars and every matching charge. Splits count your share.
struct PayeeHistoryView: View {
    @Environment(AppModel.self) private var model
    /// `name` for a payee, `recurringId` for a bill.
    let match: URLQueryItem
    let title: String
    /// The ids of transactions edited or deleted here, once their sheet has closed.
    let onChange: (Set<String>) async -> Void

    @State private var lastLoad: Loaded<PayeeHistory>?
    @State private var rows: [PayeeHistoryRow] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var generation = 0
    @State private var error: String?
    @State private var opened: LedgerTransaction?
    @State private var openGeneration = 0
    @State private var changed: Set<String> = []

    var body: some View {
        List {
            if let lastLoad {
                let history = lastLoad.value
                Section {
                    LastUpdated(loaded: lastLoad)
                    LabeledContent(history.totalCents < 0 ? "Back, last 12 months" : "Last 12 months") {
                        MoneyText(cents: abs(history.totalCents), colored: false)
                    }
                    let average = Money.format(abs(history.averageCents))
                    Text(history.averageCents < 0 ? "About \(average)/month back" : "About \(average)/month")
                        .textStyle(.subhead, color: Palette.secondaryText)
                    // x is the unique "YYYY-MM"; only the label is the initial, or same-letter months would merge
                    Chart(history.months, id: \.month) { month in
                        BarMark(x: .value("Month", month.month), y: .value("Spent", Double(month.cents) / 100))
                            .foregroundStyle(Palette.accent)
                            .accessibilityLabel(ReconcileMonth.title(month.month))
                            .accessibilityValue(Money.format(month.cents))
                    }
                    .chartXAxis { AxisMarks { value in AxisValueLabel { Text(value.as(String.self).map(Self.initial) ?? "") } } }
                    .chartYAxis { AxisMarks(format: .currency(code: "USD").precision(.fractionLength(0...2))) }
                    .frame(height: Space.xxl * 4)
                }
                Section {
                    ForEach(rows) { row in
                        Button { Task { await open(row) } } label: {
                            ListRow(title: row.name, subtitle: subtitle(row)) { MoneyText(cents: row.shareCents, colored: false) }
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .onAppear {
                            if row.id == rows.last?.id, cursor != nil { Task { await load(reset: false) } }
                        }
                    }
                    if rows.isEmpty { Text("No charges found").textStyle(.subhead, color: Palette.secondaryText) }
                }
            }
            if loading || (lastLoad == nil && error == nil) { ProgressView().frame(maxWidth: .infinity) }
            InlineError(message: error)
        }
        .themedForm()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load(reset: true) }
        .refreshable { await load(reset: true) }
        // the screen behind hears about edits only after this sheet has gone, so it can close itself cleanly
        .sheet(item: $opened, onDismiss: sendChanges) { transaction in
            TransactionDetailSheet(transaction: transaction, showsHistory: false) {
                changed.insert(transaction.id)
                // a swipe-down change arrives after onDismiss
                if opened == nil { sendChanges() }
                await load(reset: true)
            }
        }
    }

    private static func initial(_ month: String) -> String {
        Int(month.suffix(2)).flatMap { (1...12).contains($0) ? Calendar.current.veryShortMonthSymbols[$0 - 1] : nil } ?? ""
    }

    private func subtitle(_ row: PayeeHistoryRow) -> String {
        [DayText.display(row.date), row.upcoming ? "Upcoming" : nil, row.totalCents.map { "\(Money.format($0)) · your share" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private func sendChanges() {
        guard !changed.isEmpty else { return }
        let ids = changed
        changed = []
        Task { await onChange(ids) }
    }

    private func load(reset: Bool) async {
        guard let reader = model.reader, reset || !loading else { return }
        if reset { generation += 1 }
        let gen = generation
        loading = true
        defer { if gen == generation { loading = false } }
        var query = [match]
        if !reset, let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        do {
            let page = try await reader.read("/v1/payee-history", query: query, as: PayeeHistory.self)
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

    /// Rows carry ids only, so the transaction is read fresh; a slow read must not open over a sheet a later tap already opened.
    private func open(_ row: PayeeHistoryRow) async {
        guard let reader = model.reader else { return }
        openGeneration += 1
        let gen = openGeneration
        do {
            let transaction = try await reader.read("/v1/transactions/\(row.transactionId)", as: LedgerTransaction.self).value
            guard gen == openGeneration, opened == nil else { return }
            opened = transaction
            error = nil
        } catch ClientError.api(status: 404, _) {
            await load(reset: true)
        } catch {
            self.error = errorMessage(error)
        }
    }
}
