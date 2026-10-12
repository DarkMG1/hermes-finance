import HermesKit
import SwiftUI

struct HoldingView: View {
    /// Starts as the tapped row; each load replaces it with the server's latest.
    @State private var holding: Holding
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.selectedTab) private var selectedTab
    @AppStorage("hideBalances") private var hideBalances = true
    @State private var range = NetWorthRange.month
    @State private var history: LoadState<NetWorthHistory> = .loading
    @State private var scrubbed: Date?

    /// The Investments chips' selection; empty = all accounts.
    let accountIds: Set<String>
    /// Investments' eye: amounts shown on that visit show here too.
    @Binding var revealed: Bool

    init(holding: Holding, accountIds: Set<String> = [], revealed: Binding<Bool> = .constant(false)) {
        _holding = State(initialValue: holding)
        self.accountIds = accountIds
        _revealed = revealed
    }

    private var hidden: Bool { hideBalances && !revealed }

    var body: some View {
        Screen(title: holding.ticker ?? holding.name) {
            Card { header }
            Picker("Range", selection: $range) {
                ForEach(NetWorthRange.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: history, retry: { Task { await load() } }) { loaded in
                LastUpdated(loaded: loaded)
                if loaded.value.points.count < 2 {
                    Text("History starts today. Check back tomorrow.").textStyle(.subhead, color: Palette.secondaryText)
                } else {
                    Card { HistoryChart(points: loaded.value.points, scrubbed: $scrubbed) }
                    if let through = loaded.value.estimatedThrough { EstimatedFootnote(through: through) }
                }
            }
            Card {
                Text("Accounts").textStyle(.headline)
                ForEach(holding.accounts) { account in
                    ListRow(title: account.accountName, subtitle: holding.isCash || hidden ? nil : "\(sharesText(account.quantity)) shares") {
                        MoneyText(cents: account.valueCents, colored: false, negativeIsLoss: true)
                            .redacted(reason: hidden ? .placeholder : [])
                    }
                }
            }
        }
        .environment(\.balancesRevealed, revealed)
        .onChange(of: scenePhase) { _, phase in if phase == .background { revealed = false } }
        .onChange(of: selectedTab) { revealed = false }
        .task { await loadHolding() }
        .task(id: range) {
            if case .failed = history { history = .loading }
            scrubbed = nil
            await load()
        }
        .refreshable {
            await loadHolding()
            await load()
        }
    }

    /// Keeps the last holding shown when it is no longer held.
    private func loadHolding() async {
        guard let reader = model.reader,
              let loaded = try? await reader.read("/v1/investments", query: InvestmentFilter.queryItems(accountIds), as: Investments.self),
              !Task.isCancelled,
              let latest = loaded.value.holdings.first(where: { $0.key == holding.key }) else { return }
        holding = latest
    }

    @ViewBuilder private var header: some View {
        if case .loaded(let loaded) = history, let point = HistoryChart.point(at: scrubbed, in: loaded.value.points) {
            Text(DayText.display(point.date)).textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: point.netWorthCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hidden ? .placeholder : [])
        } else {
            Text(holding.name).textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: holding.valueCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hidden ? .placeholder : [])
            GainText(gainCents: holding.isCash ? nil : holding.gainCents, percent: holding.gainPercent)
            if let price = holding.priceCents {
                LabeledContent("Price") { MoneyText(cents: price, colored: false) }
                    .textStyle(.body)
                    .redacted(reason: hidden ? .placeholder : [])
            }
            if let cost = holding.costBasisCents, !holding.isCash {
                LabeledContent("Total cost") { MoneyText(cents: cost, colored: false) }
                    .textStyle(.body)
                    .redacted(reason: hidden ? .placeholder : [])
            }
        }
    }

    private func load() async {
        guard let reader = model.reader else { return }
        let requested = range
        do {
            let query = holding.historyQuery + requested.queryItems + InvestmentFilter.queryItems(accountIds)
            let loaded = try await reader.read("/v1/investments/holding-history", query: query, as: NetWorthHistory.self)
            guard !Task.isCancelled, requested == range else { return }
            history = .loaded(loaded)
        } catch {
            guard !Task.isCancelled, requested == range else { return }
            history = .failed(errorMessage(error))
        }
    }
}
