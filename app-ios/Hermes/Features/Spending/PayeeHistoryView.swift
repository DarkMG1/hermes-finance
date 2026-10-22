import Charts
import HermesKit
import SwiftUI

/// One payee's spending: twelve monthly bars and every matching charge. Splits count your share.
struct PayeeHistoryView: View {
    @Environment(AppModel.self) private var model
    /// `name` (and `bank`) for a payee, `recurringId` for a bill.
    let match: [URLQueryItem]
    let title: String
    /// The ids of transactions edited or deleted here, once their sheet has closed.
    let onChange: (Set<String>) async -> Void

    @State private var lastLoad: Loaded<PayeeHistory>?
    @State private var rows: [PayeeHistoryRow] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var needsManualLoad = false
    @State private var generation = 0
    @State private var error: String?
    @State private var opened: LedgerTransaction?
    @State private var openGeneration = 0
    @State private var changed: Set<String> = []
    /// A tapped bar's "YYYY-MM": the list shows only that month.
    @State private var month: String?
    /// The month the shown rows and cursor belong to.
    @State private var loadedMonth: String?
    @State private var excluding = false

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
                    Chart(history.months, id: \.month) { bar in
                        BarMark(x: .value("Month", bar.month), y: .value("Spent", Double(bar.cents) / 100))
                            .foregroundStyle(Palette.accent.opacity(month == nil || month == bar.month ? 1 : 0.3))
                            .accessibilityLabel(ReconcileMonth.title(bar.month))
                            .accessibilityValue(month == bar.month ? "\(Money.format(bar.cents)), shown below" : Money.format(bar.cents))
                    }
                    .chartOverlay { proxy in
                        GeometryReader { geo in
                            Rectangle().fill(.clear).contentShape(Rectangle())
                                .onTapGesture { location in
                                    guard let plot = proxy.plotFrame, let tapped: String = proxy.value(atX: location.x - geo[plot].origin.x) else { return }
                                    select(tapped)
                                }
                                .accessibilityHidden(true)
                        }
                    }
                    .chartXAxis { AxisMarks { value in AxisValueLabel { Text(value.as(String.self).map(Self.initial) ?? "") } } }
                    .chartYAxis {
                        AxisMarks { value in
                            AxisGridLine()
                            AxisTick()
                            AxisValueLabel { Text(Money.format(Int(((value.as(Double.self) ?? 0) * 100).rounded()))) }
                        }
                    }
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
                    if cursor != nil && !loading && (error != nil || needsManualLoad) {
                        Button("Load more") { Task { await load(reset: false) } }
                    }
                    if rows.isEmpty { Text("No charges found").textStyle(.subhead, color: Palette.secondaryText) }
                } header: {
                    // the same filter as tapping a bar, reachable by VoiceOver
                    Menu {
                        Button("All months") { if let month { select(month) } }
                        ForEach(history.months.reversed(), id: \.month) { bar in
                            Button(ReconcileMonth.title(bar.month)) { if month != bar.month { select(bar.month) } }
                        }
                    } label: {
                        Label(month.map(ReconcileMonth.title) ?? "All months", systemImage: "line.3.horizontal.decrease")
                    }
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
        .toolbar {
            // payee mode: the longer names the prefix match took in, each one can be left out
            if let payee = match.first(where: { $0.name == "name" })?.value, let names = lastLoad?.value.names, !names.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Section("Include in History") {
                            ForEach(names, id: \.name) { item in
                                Toggle(item.name, isOn: Binding(get: { !item.excluded }, set: { on in
                                    Task { await setExcluded(item.name, !on, payee: payee) }
                                }))
                            }
                        }
                    } label: { Label("Names", systemImage: "checklist") }
                    .disabled(excluding)
                }
            }
        }
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
        [DayText.display(row.date), row.upcoming ? "Upcoming" : nil, row.reimbursed == true ? "Reimbursed" : nil,
         row.totalCents.map { "\(Money.format($0)) · your share" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// Tapping the selected month again shows every month; if that month can't load, the list stays on the one it shows.
    private func select(_ tapped: String) {
        month = month == tapped ? nil : tapped
        Task { if await !load(reset: true) { month = loadedMonth } }
    }

    private func sendChanges() {
        guard !changed.isEmpty else { return }
        let ids = changed
        changed = []
        Task { await onChange(ids) }
    }

    /// False only when this, the latest load, failed; a load overtaken by a newer one leaves the state to it.
    @discardableResult
    private func load(reset: Bool) async -> Bool {
        guard let reader = model.reader, reset || !loading else { return false }
        if reset { generation += 1 }
        let gen = generation
        loading = true
        defer { if gen == generation { loading = false } }
        let requested = month
        var query = match
        if let month { query.append(URLQueryItem(name: "month", value: month)) }
        if !reset, let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        do {
            let page = try await reader.read("/v1/payee-history", query: query, as: PayeeHistory.self)
            guard gen == generation, !Task.isCancelled else { return true }
            let previousLastID = rows.last?.id
            rows = (reset ? [] : rows).appendingPage(page.value.rows)
            // An unchanged last row won't appear again to request the next page.
            needsManualLoad = rows.last?.id == previousLastID
            loadedMonth = requested
            cursor = page.value.nextCursor
            lastLoad = page
            error = nil
            return true
        } catch {
            guard gen == generation, !Task.isCancelled else { return true }
            self.error = errorMessage(error)
            return false
        }
    }

    private func setExcluded(_ name: String, _ excluded: Bool, payee: String) async {
        guard !excluding, let client = model.client else { return }
        excluding = true
        defer { excluding = false }
        do {
            try await client.putHistoryExclusion(name: payee, excludedName: name, excluded: excluded)
            await load(reset: true)
        } catch {
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
