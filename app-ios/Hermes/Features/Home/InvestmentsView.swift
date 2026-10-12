import HermesKit
import SwiftUI

struct InvestmentsView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.selectedTab) private var selectedTab
    @AppStorage("hideBalances") private var hideBalances = true
    @State private var range = NetWorthRange.month
    @State private var holdings: LoadState<Investments> = .loading
    @State private var history: LoadState<NetWorthHistory> = .loading
    @State private var scrubbed: Date?
    /// Empty = all accounts. Per visit, not remembered.
    @State private var selected: Set<String> = []
    /// This screen's eye: shows amounts here (and in holdings opened from here) only, until leaving or going to the background.
    @State private var revealed = false
    @State private var revealing = false
    @State private var revealError: String?

    var body: some View {
        Screen(title: "Investments") {
            // outside the holdings state, so the chips stay usable while loading or offline
            if investmentAccounts.count > 1 { accountChips }
            if let revealError { Text(revealError).textStyle(.caption, color: Palette.secondaryText) }
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: holdings, retry: { Task { await loadHoldings() } }) { loaded in
                LastUpdated(loaded: loaded)
                let investments = loaded.value
                Card { header(investments) }
                Picker("Range", selection: $range) {
                    ForEach(NetWorthRange.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                // swiftlint:disable:next multiple_closures_with_trailing_closure
                LoadingContent(state: history, retry: { Task { await loadHistory() } }) { loadedHistory in
                    if loadedHistory.value.points.count < 2 {
                        Text("History starts today. Check back tomorrow.").textStyle(.subhead, color: Palette.secondaryText)
                    } else {
                        Card { HistoryChart(points: loadedHistory.value.points, scrubbed: $scrubbed) }
                        if let through = loadedHistory.value.estimatedThrough { EstimatedFootnote(through: through) }
                    }
                }
                if !investments.holdings.isEmpty {
                    Card {
                        Text("Holdings").textStyle(.headline)
                        ForEach(investments.holdings) { holding in
                            NavigationLink { HoldingView(holding: holding, accountIds: selected, revealed: $revealed) } label: { row(holding) }
                                .buttonStyle(.plain)
                            if holding.id != investments.holdings.last?.id { Divider().overlay(Palette.separator) }
                        }
                    }
                }
            }
        }
        .environment(\.balancesRevealed, revealed)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if hidden {
                        Task { await reveal() }
                    } else {
                        revealed = false
                        hideBalances = true
                        revealError = nil
                    }
                } label: {
                    Image(systemName: hidden ? "eye" : "eye.slash")
                }
                .accessibilityLabel(hidden ? "Show balances" : "Hide balances")
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .background { revealed = false } }
        // tabs keep this screen alive: switching away counts as leaving
        .onChange(of: selectedTab) { revealed = false }
        .task(id: selected) { await loadHoldings() }
        // an account hidden elsewhere would stay in the filter with no chip left to clear it
        .onChange(of: investmentAccounts.map(\.id)) { _, ids in select(selected.intersection(ids)) }
        .task(id: historyKey) {
            if case .failed = history { history = .loading }
            scrubbed = nil
            await loadHistory()
        }
        .refreshable {
            await loadHoldings()
            await loadHistory()
        }
    }

    private var hidden: Bool { hideBalances && !revealed }

    private func reveal() async {
        guard !revealing else { return }
        revealing = true
        defer { revealing = false }
        revealError = nil
        let check = await confirmShowBalances(lock: lock, model: model)
        revealed = check.shown
        revealError = check.error
    }

    private var investmentAccounts: [Account] { model.accounts.filter { $0.type == "investment" && !$0.hidden } }

    private var historyKey: String { "\(range.rawValue)|\(selected.sorted())" }

    private var accountChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s) {
                Menu {
                    Toggle("All accounts", isOn: Binding(get: { selected.isEmpty }, set: { if $0 { select([]) } }))
                    Divider()
                    ForEach(investmentAccounts) { account in
                        Toggle(account.name, isOn: Binding(get: { selected.contains(account.id) }, set: { on in
                            var next = selected
                            if on { next.insert(account.id) } else { next.remove(account.id) }
                            select(next)
                        }))
                    }
                } label: {
                    FilterChip(title: accountsTitle, active: !selected.isEmpty, showsMenu: true)
                }
                // stays open so several accounts can be ticked in one go
                .menuActionDismissBehavior(.disabled)
            }
            .padding(.vertical, Space.xs)
        }
    }

    private var accountsTitle: String {
        switch selected.count {
        case 0: "Account"
        case 1: investmentAccounts.first { selected.contains($0.id) }?.name ?? "Account"
        default: "\(selected.count) accounts"
        }
    }

    private func select(_ ids: Set<String>) {
        guard ids != selected else { return }
        selected = ids
        // the old rows and chart belong to the old selection: spinners until the new one loads
        holdings = .loading
        history = .loading
    }

    /// While dragging, the header shows the chosen day's total instead of today's.
    @ViewBuilder private func header(_ investments: Investments) -> some View {
        if case .loaded(let loadedHistory) = history, let point = HistoryChart.point(at: scrubbed, in: loadedHistory.value.points) {
            Text(DayText.display(point.date)).textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: point.netWorthCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hidden ? .placeholder : [])
        } else {
            Text("Investments").textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: investments.totalCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hidden ? .placeholder : [])
            GainText(gainCents: investments.gainCents, percent: investments.gainPercent)
        }
    }

    private func row(_ holding: Holding) -> some View {
        // share counts are amounts: hidden with balances
        let shares = holding.isCash || hidden ? nil : "\(sharesText(holding.quantity)) shares"
        let subtitle = [holding.ticker, shares].compactMap { $0 }.joined(separator: " · ")
        return ListRow(title: holding.name, subtitle: subtitle.isEmpty ? nil : subtitle) {
            VStack(alignment: .trailing, spacing: Space.xs) {
                MoneyText(cents: holding.valueCents, colored: false, negativeIsLoss: true)
                    .redacted(reason: hidden ? .placeholder : [])
                GainText(gainCents: holding.isCash ? nil : holding.gainCents, percent: nil)
            }
            Image(systemName: "chevron.right").textStyle(.caption, color: Palette.secondaryText)
        }
    }

    private func loadHoldings() async {
        guard let reader = model.reader else { return }
        let requested = selected
        do {
            let loaded = try await reader.read("/v1/investments", query: InvestmentFilter.queryItems(requested), as: Investments.self)
            guard !Task.isCancelled, requested == selected else { return }
            holdings = .loaded(loaded)
        } catch {
            guard !Task.isCancelled, requested == selected else { return }
            holdings = .failed(errorMessage(error))
        }
    }

    private func loadHistory() async {
        guard let reader = model.reader else { return }
        let requested = historyKey
        do {
            let loaded = try await reader.read("/v1/investments/history", query: range.queryItems + InvestmentFilter.queryItems(selected),
                                         as: NetWorthHistory.self)
            guard !Task.isCancelled, requested == historyKey else { return }
            history = .loaded(loaded)
        } catch {
            guard !Task.isCancelled, requested == historyKey else { return }
            history = .failed(errorMessage(error))
        }
    }
}

/// Up to 4 decimals for fractional shares.
func sharesText(_ quantity: Double) -> String {
    quantity.formatted(.number.precision(.fractionLength(0...4)))
}

func gainColor(_ cents: Int) -> Color {
    cents < 0 ? Palette.loss : cents > 0 ? Palette.gain : Palette.text
}

/// "+$1.20 (3.4%)" style gain line; nothing when the gain is unknown. Neutral colour while balances are hidden.
struct GainText: View {
    let gainCents: Int?
    let percent: Double?
    @AppStorage("hideBalances") private var hideBalances = true
    @Environment(\.balancesRevealed) private var revealed

    var body: some View {
        let hidden = hideBalances && !revealed
        if let gainCents {
            HStack(spacing: Space.s) {
                MoneyText(cents: gainCents, colored: !hidden, negativeIsLoss: !hidden)
                if let percent {
                    Text(percent.formatted(.percent.precision(.fractionLength(1))))
                        .textStyle(.subhead, color: hidden ? Palette.text : gainColor(gainCents))
                        .accessibilityHidden(hidden)
                }
            }
            .redacted(reason: hidden ? .placeholder : [])
        }
    }
}
