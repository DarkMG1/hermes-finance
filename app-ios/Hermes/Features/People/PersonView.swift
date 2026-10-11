import HermesKit
import SwiftUI

/// One person: who owes whom, and every entry newest first with the balance after it.
struct PersonView: View {
    @Environment(AppModel.self) private var model
    let personId: String
    @State private var state: LoadState<PersonDetail> = .loading
    @State private var opening: LedgerTransaction?
    @State private var editing: Person?
    @State private var adding: Adding?
    @State private var picked: LedgerTransaction?
    @State private var splitting: LedgerTransaction?

    /// One + choice: log a cost they or you paid, or share an expense already in the ledger.
    private enum Adding: Identifiable {
        case theyPaid(Person), iPaid(Person), existing
        var id: String {
            switch self {
            case .theyPaid(let person): "they-\(person.id)"
            case .iPaid(let person): "me-\(person.id)"
            case .existing: "existing"
            }
        }
    }
    @State private var showEarlier = false
    @State private var error: String?

    var body: some View {
        Screen(title: model.personName(personId)) {
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                let detail = loaded.value
                LastUpdated(loaded: loaded)
                InlineError(message: error)
                Card { Text(Balance.phrase(detail.person.balanceCents)).textStyle(.headline) }
                // entries up to and including the latest settle-up are the current period; older ones fold away
                let cut = (detail.history.firstIndex(where: \.settled) ?? detail.history.count - 1) + 1
                Card {
                    if detail.history.isEmpty { Text("Nothing yet").textStyle(.subhead, color: Palette.secondaryText) }
                    ForEach(detail.history.prefix(cut)) { entry in entryView(entry) }
                }
                if cut < detail.history.count {
                    Card {
                        DisclosureGroup("Earlier", isExpanded: $showEarlier) {
                            ForEach(detail.history.dropFirst(cut)) { entry in entryView(entry) }
                        }
                        .textStyle(.headline)
                    }
                }
            }
        }
        .toolbar {
            // separate items so iOS 26 gives each its own glass capsule; always present so + never pops in after loading
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("They paid…") { if let person = payer { adding = .theyPaid(person) } }
                    Button("I paid cash…") { if let person = payer { adding = .iPaid(person) } }
                    Button("Add existing expense…") { if payer != nil { adding = .existing } }
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .disabled(payer == nil)
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
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
        .sheet(item: $adding, onDismiss: {
            // the split opens once the picker has gone: one sheet at a time
            if let picked {
                splitting = picked
                self.picked = nil
            }
        }, content: { adding in
            switch adding {
            case .theyPaid(let person): TheyPaidSheet(person: person) { await load() }
            case .iPaid(let person): TheyPaidSheet(person: person, mePaid: true) { await load() }
            case .existing: ExpensePicker { picked = $0 }
            }
        })
        .sheet(item: $splitting) { transaction in
            SplitSheet(transaction: transaction, sharingWith: personId) { await load() }
        }
    }

    /// The loaded person, unless archived: new entries can't name an archived person.
    private var payer: Person? {
        guard case .loaded(let loaded) = state, !loaded.value.person.archived else { return nil }
        return loaded.value.person
    }

    @ViewBuilder private func entryView(_ entry: HistoryEntry) -> some View {
        row(entry)
        if entry.settled {
            VStack(spacing: Space.xs) {
                Divider()
                Text("Settled").textStyle(.caption, color: Palette.secondaryText).frame(maxWidth: .infinity)
            }
        }
    }

    private func row(_ entry: HistoryEntry) -> some View {
        Button { Task { await open(entry.transactionId) } } label: {
            ListRow(title: entry.payee, subtitle: subtitle(entry)) {
                VStack(alignment: .trailing, spacing: Space.xs) {
                    Text(Money.format(entry.effectCents, showPlus: true)).textStyle(.body).monospacedDigit()
                    Text(Balance.phrase(entry.balanceAfterCents)).textStyle(.caption, color: Palette.secondaryText)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func subtitle(_ entry: HistoryEntry) -> String {
        let kind = switch entry.kind {
        case "forThem": "For them"
        case "fromThem": "From them"
        default: "Paid by them"
        }
        return [DayText.display(entry.date), kind].joined(separator: " · ")
    }

    private func open(_ transactionId: String) async {
        guard let reader = model.reader else { return }
        do {
            opening = try await reader.read("/v1/transactions/\(transactionId)", as: LedgerTransaction.self).value
            error = nil
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            let loaded = try await reader.read("/v1/people/\(personId)", as: PersonDetail.self)
            guard !Task.isCancelled else { return }
            state = .loaded(loaded)
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(errorMessage(error))
        }
    }
}
