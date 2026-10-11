import HermesKit
import SwiftUI

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var accountId: String?
    @State private var categoryId: String?
    @State private var personId: String?
    @State private var items: [LedgerTransaction] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var lastLoad: Loaded<TransactionPage>?
    @State private var selected: LedgerTransaction?
    @State private var adding = false
    @State private var generation = 0
    @State private var choosingCategory = false

    var body: some View {
        List {
            // rows sit on the same surface as the other tabs' cards
            Group {
                if let lastLoad { LastUpdated(loaded: lastLoad) }
                InlineError(message: error)
                ForEach(items) { transaction in
                    Button { selected = transaction } label: { TransactionRow(transaction: transaction) }
                        .buttonStyle(.plain)
                        .onAppear {
                            if transaction.id == items.last?.id, cursor != nil { Task { await load(reset: false) } }
                        }
                }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if !loading && items.isEmpty && error == nil {
                    Text("No transactions").textStyle(.subhead, color: Palette.secondaryText)
                }
            }
            .listRowBackground(Palette.surface)
        }
        .themedForm()
        .navigationTitle("Activity")
        .searchable(text: $query)
        .safeAreaInset(edge: .top) { filterChips }
        .sheet(isPresented: $choosingCategory) {
            NavigationStack { CategoryPicker(selection: $categoryId, noneTitle: "All categories") }
        }
        .task(id: filterKey) {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await load(reset: true)
        }
        .refreshable { await load(reset: true) }
        // an account that drops out of the picker mustn't stay selected where it can't be seen or cleared
        .onChange(of: filterAccounts.map(\.id)) { _, ids in
            if let accountId, !ids.contains(accountId) { self.accountId = nil }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { adding = true } label: { Label("Add", systemImage: "plus") }
            }
        }
        .sheet(item: $selected) { transaction in
            TransactionDetailSheet(transaction: transaction) { await refresh(transaction.id) }
        }
        .sheet(isPresented: $adding) {
            AddTransactionSheet { await load(reset: true) }
        }
    }

    // investment accounts have no transactions; they only count toward net worth
    private var filterAccounts: [Account] { model.accounts.filter { !$0.hidden && $0.type != "investment" } }

    private var filterKey: String { "\(query)|\(accountId ?? "")|\(categoryId ?? "")|\(personId ?? "")" }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s) {
                Menu {
                    Picker("Account", selection: $accountId) {
                        Text("All accounts").tag(String?.none)
                        ForEach(filterAccounts) { account in Text(account.name).tag(Optional(account.id)) }
                    }
                } label: {
                    chip(filterAccounts.first { $0.id == accountId }?.name ?? "Account", active: accountId != nil)
                }
                Button { choosingCategory = true } label: {
                    chip(categoryId == nil ? "Category" : model.categoryName(categoryId), active: categoryId != nil)
                }
                .buttonStyle(.plain)
                Menu {
                    Picker("Person", selection: $personId) {
                        Text("Everyone").tag(String?.none)
                        ForEach(model.people.filter { !$0.archived || $0.id == personId }) { person in Text(person.name).tag(Optional(person.id)) }
                    }
                } label: {
                    chip(personId.map(model.personName) ?? "Person", active: personId != nil)
                }
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.xs)
        }
    }

    private func chip(_ title: String, active: Bool) -> some View {
        HStack(spacing: Space.xs) {
            Text(title).textStyle(.subhead, color: active ? Palette.background : Palette.text).lineLimit(1)
            Image(systemName: "chevron.down").textStyle(.caption, color: active ? Palette.background : Palette.secondaryText)
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, Space.s)
        .background(active ? Palette.accent : Palette.surface, in: Capsule())
    }

    /// Re-reads one edited row in place: reloading from the first page drops the later pages and jumps the list.
    private func refresh(_ id: String) async {
        guard let reader = model.reader else { return }
        do {
            let fresh = try await reader.read("/v1/transactions/\(id)", as: LedgerTransaction.self).value
            if let index = items.firstIndex(where: { $0.id == id }) { items[index] = fresh }
        } catch ClientError.api(status: 404, _) {
            items.removeAll { $0.id == id }
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
        let request = TransactionQuery(accountId: accountId, categoryId: categoryId, q: query, cursor: reset ? nil : cursor, personId: personId)
        do {
            let page = try await reader.read("/v1/transactions", query: request.items, as: TransactionPage.self)
            guard gen == generation, !Task.isCancelled else { return }
            items = reset ? page.value.transactions : items + page.value.transactions
            cursor = page.value.nextCursor
            lastLoad = page
            error = nil
        } catch {
            guard gen == generation, !Task.isCancelled else { return }
            self.error = errorMessage(error)
        }
    }
}
