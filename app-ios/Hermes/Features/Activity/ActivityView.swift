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
            // its own section, so the rows' section rounds the first transaction's top corners
            Section {
                filterChips
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            // rows sit on the same surface as the other tabs' cards
            Section {
                if let lastLoad { LastUpdated(loaded: lastLoad) }
                InlineError(message: error)
                ForEach(items) { transaction in
                    Button { selected = transaction } label: { TransactionRow(transaction: transaction) }
                        .buttonStyle(.plain)
                        .onAppear {
                            if transaction.id == items.last?.id, cursor != nil { Task { await load(reset: false) } }
                        }
                }
                // before the first answer an empty list means nothing yet, not no transactions
                if loading || (lastLoad == nil && error == nil) { ProgressView().frame(maxWidth: .infinity) }
                if !loading && items.isEmpty && error == nil && lastLoad != nil {
                    Text("No transactions").textStyle(.subhead, color: Palette.secondaryText)
                }
            }
            .listRowBackground(Palette.surface)
        }
        .listSectionSpacing(Space.xs)
        // 12 + the chips' 4pt padding = the 16pt the other tabs leave under the title
        .contentMargins(.top, Space.m, for: .scrollContent)
        .background(HideSearchOnOpen())
        .themedForm()
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query)
        .sheet(isPresented: $choosingCategory) {
            NavigationStack {
                CategoryPicker(selection: $categoryId, noneTitle: "All categories")
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { choosingCategory = false } } }
            }
        }
        .task(id: filterKey) {
            // typing waits for a pause; the first load doesn't
            if lastLoad != nil { try? await Task.sleep(for: .milliseconds(300)) }
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
            TransactionDetailSheet(transaction: transaction, onOthersChange: { ids in for id in ids { await refresh(id) } },
                                   onChange: { await refresh(transaction.id) })
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
                    FilterChip(title: filterAccounts.first { $0.id == accountId }?.name ?? "Account", active: accountId != nil, showsMenu: true)
                }
                Button { choosingCategory = true } label: {
                    FilterChip(title: categoryId == nil ? "Category" : model.categoryName(categoryId), active: categoryId != nil, showsMenu: true)
                }
                .buttonStyle(.plain)
                Menu {
                    Picker("Person", selection: $personId) {
                        Text("Everyone").tag(String?.none)
                        ForEach(model.people.filter { !$0.archived || $0.id == personId }) { person in Text(person.name).tag(Optional(person.id)) }
                    }
                } label: {
                    FilterChip(title: personId.map(model.personName) ?? "Person", active: personId != nil, showsMenu: true)
                }
            }
            .padding(.vertical, Space.xs)
        }
    }

    /// Re-reads one edited row in place: reloading from the first page drops the later pages and jumps the list.
    /// A changed date is the exception, since the row moves across the paging cursor.
    private func refresh(_ id: String) async {
        guard let reader = model.reader else { return }
        do {
            let fresh = try await reader.read("/v1/transactions/\(id)", as: LedgerTransaction.self).value
            guard let index = items.firstIndex(where: { $0.id == id }) else { return }
            // a new date moves the row across the paging cursor, so the loaded pages are stale
            if fresh.date != items[index].date { await load(reset: true); return }
            items[index] = fresh
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

/// With an inline title the List opens with the search drawer already shown, and UIKit only collapses it on a scroll.
/// Nudging the list once on first appearance tucks it away; pull-down and scroll then behave natively.
/// iOS 26 also draws the field at the top of its 60pt drawer, flush against the bar, so it's shifted down, never past 4pt above the bar's bottom.
private struct HideSearchOnOpen: UIViewRepresentable {
    func makeUIView(context: Context) -> Nudge { Nudge() }
    func updateUIView(_ uiView: Nudge, context: Context) {}

    final class Nudge: UIView {
        private var done = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil, !done else { return }
            done = true
            DispatchQueue.main.async { self.nudge(tries: 10) }
        }

        private func nudge(tries: Int) {
            guard let controller = controller(), let scroll = firstScroll(in: controller.view) else {
                if tries > 0 { DispatchQueue.main.async { self.nudge(tries: tries - 1) } }
                return
            }
            if let bar = controller.navigationItem.searchController?.searchBar {
                // UIKit re-sets the bar's frame on every layout, which cancels a view transform; a sublayer transform sticks
                // the field's bottom stays 4pt inside the bar: past it, the field covers the pull-to-refresh spinner
                // convert sees the sublayer transform, so clear it before measuring or a re-run measures its own shift
                bar.layer.sublayerTransform = CATransform3DIdentity
                let spare = bar.bounds.height - bar.convert(bar.searchTextField.bounds, from: bar.searchTextField).maxY
                bar.layer.sublayerTransform = CATransform3DMakeTranslation(0, max(0, spare - 4), 0)
            }
            scroll.contentOffset.y += 100
            DispatchQueue.main.async { scroll.contentOffset.y = -scroll.adjustedContentInset.top }
        }

        private func controller() -> UIViewController? {
            var responder: UIResponder? = self
            while let next = responder, !(next is UIViewController) { responder = next.next }
            return responder as? UIViewController
        }

        private func firstScroll(in view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView { return scroll }
            return view.subviews.lazy.compactMap { self.firstScroll(in: $0) }.first
        }
    }
}
