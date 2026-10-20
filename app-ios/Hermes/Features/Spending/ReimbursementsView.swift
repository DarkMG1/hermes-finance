import HermesKit
import SwiftUI

/// The Reimbursement category by month: what went out for others, what came back, and what's still unpaid.
struct ReimbursementsView: View {
    @Environment(AppModel.self) private var model
    @State private var lastLoad: Loaded<Reimbursements>?
    @State private var error: String?
    @State private var opened: LedgerTransaction?
    @State private var openGeneration = 0

    var body: some View {
        List {
            if let lastLoad {
                Section("Last 12 months") {
                    LastUpdated(loaded: lastLoad)
                    ForEach(lastLoad.value.months, id: \.month) { month in
                        monthRow(month, rows: lastLoad.value.rows.filter { $0.date.hasPrefix(month.month) })
                    }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            InlineError(message: error)
        }
        .themedForm()
        .navigationTitle("Reimbursements")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $opened) { transaction in TransactionDetailSheet(transaction: transaction) { await load() } }
    }

    @ViewBuilder
    private func monthRow(_ month: ReimbursementMonth, rows: [ReimbursementRow]) -> some View {
        let label = ListRow(title: ReconcileMonth.title(month.month), subtitle: status(month)) {
            if month.unpaidCents != 0 {
                HStack(spacing: Space.xs) {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Palette.loss).accessibilityHidden(true)
                    MoneyText(cents: abs(month.unpaidCents), colored: false)
                }
            }
        }
        if rows.isEmpty {
            label
        } else {
            DisclosureGroup {
                ForEach(rows) { row in
                    Button { Task { await open(row.transactionId) } } label: {
                        ListRow(title: row.name, subtitle: DayText.display(row.date)) { MoneyText(cents: row.amountCents) }
                    }
                    .buttonStyle(.plain)
                }
            } label: { label }
        }
    }

    private func status(_ month: ReimbursementMonth) -> String {
        if month.outCents == 0 && month.inCents == 0 { return "None" }
        if month.unpaidCents == 0 { return "Paid back" }
        let detail = "\(Money.format(month.outCents)) out · \(Money.format(month.inCents)) back"
        return "\(month.unpaidCents > 0 ? "Unpaid" : "Paid back extra") · \(detail)"
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            let loaded = try await reader.read("/v1/reimbursements", as: Reimbursements.self)
            guard !Task.isCancelled else { return }
            lastLoad = loaded
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = errorMessage(error)
        }
    }

    /// Rows carry ids only, so the transaction is read fresh; a slow read must not open over a sheet a later tap already opened.
    private func open(_ id: String) async {
        guard let reader = model.reader else { return }
        openGeneration += 1
        let gen = openGeneration
        do {
            let transaction = try await reader.read("/v1/transactions/\(id)", as: LedgerTransaction.self).value
            guard gen == openGeneration, opened == nil else { return }
            opened = transaction
            error = nil
        } catch ClientError.api(status: 404, _) {
            await load()
        } catch {
            self.error = errorMessage(error)
        }
    }
}
