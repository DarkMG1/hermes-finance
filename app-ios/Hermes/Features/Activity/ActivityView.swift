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

    var body: some View {
        List {
            // plain-list rows draw the system background (pure black in dark mode) unless told otherwise
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
            .listRowBackground(Palette.background)
        }
        .listStyle(.plain)
        .themedForm()
        .navigationTitle("Activity")
        .searchable(text: $query)
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
            ToolbarItem(placement: .topBarLeading) { filterMenu }
            ToolbarItem(placement: .topBarTrailing) {
                Button { adding = true } label: { Label("Add", systemImage: "plus") }
            }
        }
        .sheet(item: $selected) { transaction in
            TransactionDetailSheet(transaction: transaction) { await load(reset: true) }
        }
        .sheet(isPresented: $adding) {
            AddTransactionSheet { await load(reset: true) }
        }
    }

    // investment accounts have no transactions; they only count toward net worth
    private var filterAccounts: [Account] { model.accounts.filter { !$0.hidden && $0.type != "investment" } }

    private var filterKey: String { "\(query)|\(accountId ?? "")|\(categoryId ?? "")|\(personId ?? "")" }

    private var filterMenu: some View {
        Menu {
            Picker("Account", selection: $accountId) {
                Text("All accounts").tag(String?.none)
                ForEach(filterAccounts) { account in Text(account.name).tag(Optional(account.id)) }
            }
            Picker("Category", selection: $categoryId) {
                Text("All categories").tag(String?.none)
                ForEach(model.categories.filter { !$0.hidden }) { category in Text(category.name).tag(Optional(category.id)) }
            }
            Picker("Person", selection: $personId) {
                Text("Everyone").tag(String?.none)
                ForEach(model.people.filter { !$0.archived || $0.id == personId }) { person in Text(person.name).tag(Optional(person.id)) }
            }
        } label: {
            let active = accountId != nil || categoryId != nil || personId != nil
            Label("Filter", systemImage: active ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
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
