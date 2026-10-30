import HermesKit
import SwiftUI

struct SpendingView: View {
    @Environment(AppModel.self) private var model
    @State private var period = SpendingPeriod.current(today: DayText.ymd(.now))
    @State private var state: LoadState<Spending> = .loading
    @State private var loadedPeriod: SpendingPeriod?
    @State private var dueThisWeek = 0
    @State private var unpaid = 0

    var body: some View {
        Screen(title: "Spending") {
            Picker("Period", selection: Binding(get: { period.kind }, set: { period = period.with(kind: $0, today: DayText.ymd(.now)) })) {
                Text("Month").tag(SpendingPeriod.Kind.month)
                Text("Year").tag(SpendingPeriod.Kind.year)
            }
            .pickerStyle(.segmented)
            HStack {
                Button { period = period.previous() } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel("Previous period")
                Spacer()
                Text(period.title).textStyle(.headline)
                Spacer()
                Button { period = period.next() } label: { Image(systemName: "chevron.right") }
                    .accessibilityLabel("Next period")
                    .disabled(!period.canGoNext(today: DayText.ymd(.now)))
            }
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                LastUpdated(loaded: loaded)
                Card {
                    NavigationLink { expenses("Income", ExpensesQuery(period: period, kind: .in), total: loaded.value.inCents) } label: {
                        ListRow(title: "In") { amount(loaded.value.inCents, chevron: true) }
                    }
                    .buttonStyle(.plain)
                    ListRow(title: "Out") { amount(loaded.value.outCents, chevron: false) }
                    ListRow(title: "Net") { MoneyText(cents: loaded.value.netCents) }
                }
                if loaded.value.categories.isEmpty {
                    Text("No spending in this period").textStyle(.subhead, color: Palette.secondaryText)
                } else {
                    Card {
                        let top = Array(loaded.value.categories.prefix(8))
                        let most = max(top.map(\.spentCents).max() ?? 1, 1)
                        // plain rows, not Swift Charts: on device its category axis drew each name half a row above its bar
                        Grid(alignment: .leading, horizontalSpacing: Space.s, verticalSpacing: Space.s) {
                            ForEach(top, id: \.name) { category in
                                GridRow {
                                    Text(category.name).textStyle(.caption, color: Palette.secondaryText).lineLimit(1)
                                    GeometryReader { bar in
                                        RoundedRectangle(cornerRadius: Space.xs)
                                            .fill(Palette.accent)
                                            .frame(width: bar.size.width * max(CGFloat(category.spentCents), 0) / CGFloat(most))
                                    }
                                    .frame(height: Space.l + Space.s)
                                }
                            }
                        }
                    }
                    Card {
                        ForEach(loaded.value.categories, id: \.listId) { category in
                            NavigationLink {
                                expenses(category.name, ExpensesQuery(period: period, kind: .out, categoryId: category.listId), total: category.spentCents)
                            } label: {
                                ListRow(title: category.name) { amount(category.spentCents, chevron: true) }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                // a fully refunded period has rows but no categories
                Card {
                    NavigationLink { expenses("Expenses", ExpensesQuery(period: period, kind: .out), total: loaded.value.outCents) } label: {
                        ListRow(title: "All expenses") { Image(systemName: "chevron.right").textStyle(.caption, color: Palette.secondaryText) }
                    }
                    .buttonStyle(.plain)
                    NavigationLink { ReimbursementsView() } label: {
                        ListRow(title: "Reimbursements", subtitle: unpaid > 0 ? "\(Money.format(unpaid)) unpaid" : nil) {
                            Image(systemName: "chevron.right").textStyle(.caption, color: Palette.secondaryText)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .task(id: period) {
            // coming back from Expenses re-runs this; keep the list (and scroll) unless the period moved
            if loadedPeriod != period { state = .loading }
            await load()
        }
        .task { await loadDue() }
        .task { await loadUnpaid() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { RecurringView() } label: {
                    Image(systemName: "calendar").padding(Space.s).overlay(alignment: .topTrailing) { CountBadge(count: dueThisWeek) }
                }
                .accessibilityLabel("Recurring")
                .accessibilityValue(dueThisWeek > 0 ? "\(dueThisWeek) due this week" : "")
            }
        }
        .refreshable { await load(); await loadDue(); await loadUnpaid() }
    }

    private func loadDue() async {
        if let list = try? await model.client?.recurring() { dueThisWeek = list.dueThisWeek }
    }

    private func loadUnpaid() async {
        if let loaded = try? await model.reader?.read("/v1/reimbursements", as: Reimbursements.self) {
            unpaid = loaded.value.unpaidCents
        }
    }

    private func expenses(_ title: String, _ query: ExpensesQuery, total: Int) -> some View {
        ExpensesView(title: title, query: query, total: total) {
            await load()
            return currentTotal(query)
        }
    }

    /// The number behind an Expenses screen after a reload; a category that emptied out is gone from the list, so it's 0.
    private func currentTotal(_ query: ExpensesQuery) -> Int? {
        // a reload that fell back to saved data must not pass for the fresh total
        guard case .loaded(let loaded) = state, !loaded.fromCache else { return nil }
        if query.kind == .in { return loaded.value.inCents }
        guard let id = query.categoryId else { return loaded.value.outCents }
        return loaded.value.categories.first { $0.listId == id }?.spentCents ?? 0
    }

    private func amount(_ cents: Int, chevron: Bool) -> some View {
        HStack(spacing: Space.s) {
            MoneyText(cents: cents, colored: false)
            if chevron { Image(systemName: "chevron.right").textStyle(.caption, color: Palette.secondaryText) }
        }
    }

    private func load() async {
        guard let reader = model.reader else { return }
        let requested = period
        do {
            let loaded = try await reader.read("/v1/spending", query: requested.queryItems, as: Spending.self)
            guard !Task.isCancelled, requested == period else { return }
            state = .loaded(loaded)
            loadedPeriod = requested
        } catch {
            guard !Task.isCancelled, requested == period else { return }
            state = .failed(errorMessage(error))
            loadedPeriod = requested
        }
    }
}

private extension SpendingCategory {
    /// Names need not be unique; this is also what Expenses filters by.
    var listId: String { categoryId ?? ExpensesQuery.uncategorized }
}
