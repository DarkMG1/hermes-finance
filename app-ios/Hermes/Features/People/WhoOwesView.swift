import HermesKit
import SwiftUI

/// Who owes the owner, and how much; likely repayments to confirm.
struct WhoOwesView: View {
    @Environment(AppModel.self) private var model
    @State private var state: LoadState<[Person]> = .loading
    @State private var suggestions: [RepaymentSuggestion] = []
    @State private var settings: PeopleSettings?
    @State private var selected: LedgerTransaction?
    @State private var adding = false
    @State private var addingFor: LedgerTransaction?
    @State private var showSettled = false
    @State private var writes: [String: WriteGuard] = [:]
    @State private var busyIds: Set<String> = []
    @State private var errors = RequestErrors()
    @State private var loadGeneration = OpenGeneration()

    var body: some View {
        Screen(title: "IOUs") {
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                LastUpdated(loaded: loaded)
                InlineError(message: errors.message)
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
                if let settings { repaymentAccountCard(settings) }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { adding = true } label: { Label("Add person", systemImage: "person.badge.plus") }
            }
        }
        .refreshable { await load() }
        .task { await load(coalescing: true) }
        .sheet(item: $selected) { transaction in
            TransactionDetailSheet(transaction: transaction) { await load() }
        }
        .sheet(isPresented: $adding) {
            PersonSheet(person: nil) { _ in await load() }
        }
        .sheet(item: $addingFor) { transaction in
            PersonSheet(person: nil) { created in
                if let created { await tag(transaction, created.id) } else { await load() }
            }
        }
    }

    private func personLink(_ person: Person) -> some View {
        NavigationLink { PersonView(personId: person.id) } label: {
            ListRow(title: person.name, subtitle: Balance.phrase(person.balanceCents)) {
                MoneyText(cents: abs(person.balanceCents), colored: false)
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
                    Button("New person…") { addingFor = suggestion.transaction }
                }
                Button("Not a repayment") {
                    Task {
                        await perform("\(suggestion.id)|dismiss", lock: suggestion.id) { client, key in
                            try await client.dismissSuggestion(transactionId: suggestion.id, idempotencyKey: key)
                        }
                    }
                }
            }
            .textStyle(.subhead, color: Palette.accent)
            .disabled(busyIds.contains(suggestion.id))
        }
    }

    private func repaymentAccountCard(_ settings: PeopleSettings) -> some View {
        Card {
            LabeledContent("Repayments land in") {
                Menu(settings.repaymentAccountId.map(model.accountName) ?? "Any checking account") {
                    Button("Any checking account") { Task { await setRepaymentAccount(nil) } }
                    ForEach(model.accounts.filter { $0.type == "depository" && !$0.hidden }) { account in
                        Button(account.name) { Task { await setRepaymentAccount(account.id) } }
                    }
                }
            }
            .textStyle(.subhead)
        }
    }

    private func setRepaymentAccount(_ id: String?) async {
        await perform("settings|\(id ?? "")", lock: "settings") { client, key in
            _ = try await client.putPeopleSettings(PeopleSettings(repaymentAccountId: id), idempotencyKey: key)
        }
    }

    private func tag(_ transaction: LedgerTransaction, _ personId: String) async {
        await perform("\(transaction.id)|\(personId)", lock: transaction.id) { client, key in
            _ = try await client.patchTransaction(id: transaction.id, body: PatchTransactionBody(personId: .set(personId)), idempotencyKey: key)
        }
    }

    /// One key per (target, choice): retrying an unknown outcome resends the same request, and a different choice is a new one.
    /// `lock` keeps a second tap on the same suggestion from sending while the first is in flight.
    private func perform(_ slot: String, lock: String, _ write: (APIClient, String) async throws -> Void) async {
        guard let client = model.client, !busyIds.contains(lock) else { return }
        busyIds.insert(lock)
        errors.write = nil
        defer { busyIds.remove(lock) }
        var writeGuard = writes[slot] ?? WriteGuard()
        do {
            try await write(client, writeGuard.key)
            writeGuard.didSucceed()
        } catch {
            writeGuard.didFail(error)
            errors.write = writeGuard.unresolved ? "Couldn't confirm. Try again." : errorMessage(error)
        }
        writes[slot] = writeGuard
        await load()
    }

    private func load(coalescing: Bool = false) async {
        guard let reader = model.reader else { return }
        let gen = loadGeneration.next()
        async let references: Void = model.refreshReferenceData(coalescing: coalescing)
        async let supporting: Void = loadSupporting(reader: reader, generation: gen)
        do {
            let people = try await reader.read("/v1/people", as: [Person].self)
            guard !Task.isCancelled, loadGeneration.accepts(gen, presented: false) else { return }
            state = .loaded(people)
        } catch {
            guard !Task.isCancelled, loadGeneration.accepts(gen, presented: false) else { return }
            state = .failed(errorMessage(error))
        }
        _ = await (references, supporting)
    }

    private func loadSupporting(reader: Reader, generation: Int) async {
        async let loadedSettings = try? reader.read("/v1/people/settings", as: PeopleSettings.self)
        do {
            let found = try await reader.read("/v1/people/suggestions", as: [RepaymentSuggestion].self)
            guard !Task.isCancelled, loadGeneration.accepts(generation, presented: false) else { return }
            suggestions = found.value
            errors.read = nil
        } catch {
            guard !Task.isCancelled, loadGeneration.accepts(generation, presented: false) else { return }
            suggestions = []
            errors.read = errorMessage(error)
        }
        let loaded = await loadedSettings
        guard !Task.isCancelled, loadGeneration.accepts(generation, presented: false) else { return }
        settings = loaded?.value ?? settings
    }
}
