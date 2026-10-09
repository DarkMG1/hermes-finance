import HermesKit
import SwiftUI

/// One person: balance, open items (oldest repaid first), history, edit.
struct PersonView: View {
    @Environment(AppModel.self) private var model
    let personId: String
    @State private var state: LoadState<PersonDetail> = .loading
    @State private var opening: LedgerTransaction?
    @State private var editing: Person?
    @State private var showHistory = false

    var body: some View {
        Screen(title: model.personName(personId)) {
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                let detail = loaded.value
                LastUpdated(loaded: loaded)
                Card {
                    Text(detail.person.balanceCents < 0 ? "\(detail.person.name) is ahead by" : "Owes you")
                        .textStyle(.subhead, color: Palette.secondaryText)
                    MoneyText(cents: abs(detail.person.balanceCents), style: .display, colored: false)
                }
                let open = detail.owed.filter { $0.status != "paid" }
                Card {
                    Text("Open").textStyle(.headline)
                    if open.isEmpty { Text("Nothing open").textStyle(.subhead, color: Palette.secondaryText) }
                    ForEach(open) { item in
                        row(item.payee, subtitle: openSubtitle(item), cents: item.amountCents, transactionId: item.transactionId)
                    }
                }
                let paid = detail.owed.filter { $0.status == "paid" }
                if !paid.isEmpty || !detail.repayments.isEmpty {
                    Card {
                        DisclosureGroup("History", isExpanded: $showHistory) {
                            ForEach(paid) { item in
                                row(item.payee, subtitle: "\(DayText.display(item.date)) · Paid", cents: item.amountCents, transactionId: item.transactionId)
                            }
                            ForEach(detail.repayments) { item in
                                row(item.payee, subtitle: "\(DayText.display(item.date)) · Repayment", cents: item.amountCents,
                                    transactionId: item.transactionId)
                            }
                        }
                        .textStyle(.headline)
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Edit") { if case .loaded(let loaded) = state { editing = loaded.value.person } }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $opening) { transaction in
            TransactionDetailSheet(transaction: transaction) { await load() }
        }
        .sheet(item: $editing) { person in
            PersonSheet(person: person) { _ in await load() }
        }
    }

    private func openSubtitle(_ item: OwedItem) -> String {
        let date = DayText.display(item.date)
        guard item.status == "partial" else { return date }
        return "\(date) · Partly paid \(Money.format(item.paidCents)) of \(Money.format(-item.amountCents))"
    }

    private func row(_ title: String, subtitle: String, cents: Int, transactionId: String) -> some View {
        Button { Task { await open(transactionId) } } label: {
            ListRow(title: title, subtitle: subtitle) { MoneyText(cents: cents) }
        }
        .buttonStyle(.plain)
    }

    private func open(_ transactionId: String) async {
        guard let reader = model.reader,
              let loaded = try? await reader.read("/v1/transactions/\(transactionId)", as: LedgerTransaction.self) else { return }
        opening = loaded.value
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            let loaded = try await reader.read("/v1/people/\(personId)", as: PersonDetail.self)
            guard !Task.isCancelled else { return }
            state = .loaded(loaded)
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(errorMessage(error))
        }
    }
}
