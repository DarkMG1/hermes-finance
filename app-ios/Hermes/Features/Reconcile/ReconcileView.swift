import HermesKit
import SwiftUI

/// The monthly pass: every money-out row of a month gets a deliberate check. Checked rows slide away; Undo brings one back.
struct ReconcileView: View {
    @Environment(AppModel.self) private var model
    @State private var month: String?
    @State private var state: LoadState<ReconcileList> = .loading
    @State private var rows: [LedgerTransaction] = []
    /// Server order of the loaded rows, so an undone row goes back where it was.
    @State private var order: [String: Int] = [:]
    @State private var months: [ReconcileSummary] = []
    @State private var selected: LedgerTransaction?
    @State private var undo: LedgerTransaction?
    @State private var error: String?

    init(month: String? = nil) { _month = State(initialValue: month) }

    var body: some View {
        Screen(title: "Reconcile") {
            monthChip
            InlineError(message: error)
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                LastUpdated(loaded: loaded)
                if rows.isEmpty {
                    Text("\(title) is reconciled ✓").textStyle(.headline)
                    if let next = months.first(where: { $0.month != month }) {
                        HButton(title: "Go to \(ReconcileMonth.title(next.month))", kind: .secondary) { month = next.month }
                    }
                } else {
                    Text("\(rows.count) of \(loaded.value.total) left").textStyle(.subhead, color: Palette.secondaryText)
                    Card {
                        ForEach(rows) { transaction in
                            row(transaction)
                            if transaction.id != rows.last?.id { Divider().overlay(Palette.separator) }
                        }
                    }
                }
            }
        }
        .overlay(alignment: .bottom) { if let undo { undoBar(undo) } }
        .task { await loadMonths() }
        .task(id: month) { await load() }
        // an undo belongs to the month it was made in
        .onChange(of: month) { undo = nil }
        .task(id: undo?.id) {
            guard undo != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { withAnimation { undo = nil } }
        }
        .refreshable {
            await loadMonths()
            await load()
        }
        .sheet(item: $selected) { transaction in
            // the row may have left the list (recategorized as a transfer) or been reconciled in the sheet
            TransactionDetailSheet(transaction: transaction) {
                await loadMonths()
                await load()
            }
        }
    }

    private var current: String { ReconcileMonth.current(today: DayText.ymd(.now)) }

    private var title: String { ReconcileMonth.title(month ?? current) }

    private var monthChip: some View {
        let options = Array(Set(months.map(\.month) + [current] + [month].compactMap { $0 })).sorted()
        return Menu {
            Picker("Month", selection: Binding(get: { month ?? current }, set: { month = $0 })) {
                ForEach(options, id: \.self) { option in
                    let open = months.first { $0.month == option }?.open
                    Text(open.map { "\(ReconcileMonth.title(option)) · \($0)" } ?? ReconcileMonth.title(option)).tag(option)
                }
            }
        } label: {
            FilterChip(title: title, active: true, showsMenu: true)
        }
    }

    private func row(_ transaction: LedgerTransaction) -> some View {
        HStack(spacing: Space.m) {
            Button { selected = transaction } label: { TransactionRow(transaction: transaction) }
                .buttonStyle(.plain)
            Button { Task { await check(transaction) } } label: {
                Image(systemName: "circle").font(.title2).foregroundStyle(Palette.accent)
                    .frame(minWidth: Space.xxl + Space.m, minHeight: Space.xxl + Space.m)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Mark reconciled")
        }
    }

    private func undoBar(_ transaction: LedgerTransaction) -> some View {
        HStack {
            Text("Reconciled").textStyle(.subhead)
            Spacer()
            Button("Undo") { Task { await uncheck(transaction) } }
        }
        .padding(Space.m)
        .background(Palette.surface, in: Capsule())
        .padding(Space.l)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func loadMonths() async {
        guard let reader = model.reader else { return }
        guard let loaded = try? await reader.read("/v1/reconcile/months", as: ReconcileMonths.self) else {
            // still pick a month, so load() runs and shows its own error and Retry
            if month == nil { month = current }
            return
        }
        months = loaded.value.months
        // opened without a month: the oldest one with open rows, else this month
        if month == nil { month = months.first?.month ?? current }
    }

    private func load() async {
        guard let reader = model.reader, let requested = month else { return }
        do {
            let loaded = try await reader.read("/v1/reconcile", query: ReconcileMonth.queryItems(requested), as: ReconcileList.self)
            guard !Task.isCancelled, requested == month else { return }
            rows = loaded.value.transactions
            order = Dictionary(uniqueKeysWithValues: rows.enumerated().map { ($1.id, $0) })
            state = .loaded(loaded)
        } catch {
            guard !Task.isCancelled, requested == month else { return }
            state = .failed(errorMessage(error))
        }
    }

    private func check(_ transaction: LedgerTransaction) async {
        guard let client = model.client else { return }
        error = nil
        withAnimation { rows.removeAll { $0.id == transaction.id } }
        do {
            _ = try await client.setReconciled(id: transaction.id, reconciled: true, idempotencyKey: UUID().uuidString)
            // Undo shows only once the write landed, so an undo can't race it
            if inMonth(transaction) { withAnimation { undo = transaction } }
            await loadMonths()
        } catch {
            if undo?.id == transaction.id { withAnimation { undo = nil } }
            await restore(transaction)
            self.error = errorMessage(error)
        }
    }

    private func uncheck(_ transaction: LedgerTransaction) async {
        guard let client = model.client else { return }
        error = nil
        withAnimation { undo = nil }
        do {
            _ = try await client.setReconciled(id: transaction.id, reconciled: false, idempotencyKey: UUID().uuidString)
            await restore(transaction)
            await loadMonths()
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func inMonth(_ transaction: LedgerTransaction) -> Bool { transaction.date.prefix(7) == month ?? "" }

    /// Back into the list only if it's this month's row; the month may have changed while the write ran.
    private func restore(_ transaction: LedgerTransaction) async {
        if inMonth(transaction) { withAnimation { putBack(transaction) } } else { await load() }
    }

    private func putBack(_ transaction: LedgerTransaction) {
        guard !rows.contains(where: { $0.id == transaction.id }) else { return }
        rows.append(transaction)
        rows.sort { (order[$0.id] ?? .max) < (order[$1.id] ?? .max) }
    }
}
