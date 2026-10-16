import Charts
import HermesKit
import SwiftUI

/// One payee's spending: twelve monthly bars and every matching charge. Splits count your share.
struct PayeeHistoryView: View {
    @Environment(AppModel.self) private var model
    let name: String

    @State private var history: PayeeHistory?
    @State private var error: String?
    @State private var opened: LedgerTransaction?
    @State private var openGeneration = 0

    var body: some View {
        List {
            if let history {
                Section {
                    LabeledContent("Last 12 months") { MoneyText(cents: history.totalCents, colored: false) }
                    Text("About \(Money.format(history.averageCents))/month").textStyle(.subhead, color: Palette.secondaryText)
                    // x is the unique "YYYY-MM"; only the label is the initial, or same-letter months would merge
                    Chart(history.months, id: \.month) { month in
                        BarMark(x: .value("Month", month.month), y: .value("Spent", Double(month.cents) / 100))
                    }
                    .chartXAxis { AxisMarks { value in AxisValueLabel { Text(value.as(String.self).map(Self.initial) ?? "") } } }
                    .frame(height: Space.xxl * 4)
                    .accessibilityLabel("Monthly spending, last 12 months")
                }
                Section {
                    ForEach(history.rows) { row in
                        Button { Task { await open(row) } } label: {
                            ListRow(title: row.name, subtitle: subtitle(row)) { MoneyText(cents: row.shareCents, colored: false) }
                        }
                        .buttonStyle(.plain)
                    }
                    if history.rows.isEmpty { Text("No charges found").textStyle(.subhead, color: Palette.secondaryText) }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            InlineError(message: error)
        }
        .themedForm()
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $opened) { TransactionDetailSheet(transaction: $0) { await load() } }
    }

    static func initial(_ month: String) -> String {
        Int(month.suffix(2)).map { Calendar.current.veryShortMonthSymbols[$0 - 1] } ?? ""
    }

    private func subtitle(_ row: PayeeHistoryRow) -> String {
        [DayText.display(row.date), row.totalCents.map { "\(Money.format($0)) · your share" }].compactMap { $0 }.joined(separator: " · ")
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            history = try await reader.read("/v1/payee-history", query: [URLQueryItem(name: "name", value: name)], as: PayeeHistory.self).value
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
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
        } catch ClientError.api(status: 404, _) {
            await load()
        } catch {
            self.error = errorMessage(error)
        }
    }
}
