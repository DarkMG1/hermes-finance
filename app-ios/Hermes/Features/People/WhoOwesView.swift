import HermesKit
import SwiftUI

/// Who owes the owner, and how much; likely repayments to confirm.
struct WhoOwesView: View {
    @Environment(AppModel.self) private var model
    @State private var state: LoadState<[Person]> = .loading
    @State private var suggestions: [RepaymentSuggestion] = []
    @State private var selected: LedgerTransaction?
    @State private var adding = false
    @State private var showSettled = false
    @State private var writes: [String: WriteGuard] = [:]
    @State private var error: String?

    var body: some View {
        Screen(title: "Who Owes Me") {
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                LastUpdated(loaded: loaded)
                InlineError(message: error)
                if !suggestions.isEmpty {
                    Card {
                        Text("Possible repayments").textStyle(.headline)
                        ForEach(suggestions) { suggestion in suggestionRow(suggestion) }
                    }
                }
                let open = loaded.value.filter { $0.balanceCents != 0 }
                Card {
                    Text("People").textStyle(.headline)
                    if open.isEmpty { Text("Nobody owes you anything").textStyle(.subhead, color: Palette.secondaryText) }
                    ForEach(open) { person in personLink(person) }
                }
                let settled = loaded.value.filter { $0.balanceCents == 0 }
                if !settled.isEmpty {
                    Card {
                        DisclosureGroup("Settled", isExpanded: $showSettled) {
                            ForEach(settled) { person in personLink(person) }
                        }
                        .textStyle(.headline)
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { adding = true } label: { Label("Add person", systemImage: "person.badge.plus") }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $selected) { transaction in
            TransactionDetailSheet(transaction: transaction) { await load() }
        }
        .sheet(isPresented: $adding) {
            PersonSheet(person: nil) { _ in await load() }
        }
    }

    private func personLink(_ person: Person) -> some View {
        NavigationLink { PersonView(personId: person.id) } label: {
            ListRow(title: person.name, subtitle: person.balanceCents < 0 ? "Ahead by \(Money.format(-person.balanceCents))" : nil) {
                MoneyText(cents: max(person.balanceCents, 0), colored: false)
            }
        }
        .buttonStyle(.plain)
    }

    private func suggestionRow(_ suggestion: RepaymentSuggestion) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Button { selected = suggestion.transaction } label: {
                ListRow(title: suggestion.transaction.payee, subtitle: DayText.display(suggestion.transaction.date)) {
                    MoneyText(cents: suggestion.transaction.amountCents)
                }
            }
            .buttonStyle(.plain)
            HStack(spacing: Space.l) {
                if let personId = suggestion.personId {
                    Button("Confirm \(model.personName(personId))") { Task { await tag(suggestion.transaction, personId) } }
                }
                Menu(suggestion.personId == nil ? "Who paid?" : "Someone else") {
                    ForEach(model.people.filter { !$0.archived }) { person in
                        Button(person.name) { Task { await tag(suggestion.transaction, person.id) } }
                    }
                }
            }
            .textStyle(.subhead, color: Palette.accent)
        }
    }

    private func tag(_ transaction: LedgerTransaction, _ personId: String) async {
        guard let client = model.client else { return }
        // one key per (deposit, person): retrying an unknown outcome resends the same request, and choosing someone else is a new one
        let slot = "\(transaction.id)|\(personId)"
        var writeGuard = writes[slot] ?? WriteGuard()
        do {
            _ = try await client.patchTransaction(id: transaction.id, body: PatchTransactionBody(personId: .set(personId)), idempotencyKey: writeGuard.key)
            writeGuard.didSucceed()
            error = nil
        } catch {
            writeGuard.didFail(error)
            self.error = writeGuard.unresolved ? "Couldn't confirm. Try again." : errorMessage(error)
        }
        writes[slot] = writeGuard
        await load()
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            let people = try await reader.read("/v1/people", as: [Person].self)
            var found: Loaded<[RepaymentSuggestion]>?
            var suggestionsError: Error?
            do { found = try await reader.read("/v1/people/suggestions", as: [RepaymentSuggestion].self) } catch { suggestionsError = error }
            await model.refreshReferenceData()
            guard !Task.isCancelled else { return }
            suggestions = found?.value ?? []
            if let suggestionsError { error = errorMessage(suggestionsError) }
            state = .loaded(people)
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(errorMessage(error))
        }
    }
}
