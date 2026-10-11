import HermesKit
import SwiftUI

struct InvestmentsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("hideBalances") private var hideBalances = false
    @State private var range = NetWorthRange.month
    @State private var holdings: LoadState<Investments> = .loading
    @State private var history: LoadState<NetWorthHistory> = .loading
    @State private var scrubbed: Date?
    @State private var loadedRange: NetWorthRange?

    var body: some View {
        Screen(title: "Investments") {
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
                    }
                }
                if !investments.holdings.isEmpty {
                    Card {
                        Text("Holdings").textStyle(.headline)
                        ForEach(investments.holdings) { holding in
                            NavigationLink { HoldingView(holding: holding) } label: { row(holding) }
                                .buttonStyle(.plain)
                            if holding.id != investments.holdings.last?.id { Divider().overlay(Palette.separator) }
                        }
                    }
                }
            }
        }
        .task { await loadHoldings() }
        .task(id: range) {
            if loadedRange != range { history = .loading }
            scrubbed = nil
            await loadHistory()
        }
        .refreshable {
            await loadHoldings()
            await loadHistory()
        }
    }

    /// While dragging, the header shows the chosen day's total instead of today's.
    @ViewBuilder private func header(_ investments: Investments) -> some View {
        if case .loaded(let loadedHistory) = history, let point = HistoryChart.point(at: scrubbed, in: loadedHistory.value.points) {
            Text(DayText.display(point.date)).textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: point.netWorthCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hideBalances ? .placeholder : [])
        } else {
            Text("Investments").textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: investments.totalCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hideBalances ? .placeholder : [])
            GainText(gainCents: investments.gainCents, percent: investments.gainPercent)
        }
    }

    private func row(_ holding: Holding) -> some View {
        // share counts are amounts: hidden with balances
        let shares = holding.isCash || hideBalances ? nil : "\(sharesText(holding.quantity)) shares"
        let subtitle = [holding.ticker, shares].compactMap { $0 }.joined(separator: " · ")
        return ListRow(title: holding.name, subtitle: subtitle.isEmpty ? nil : subtitle) {
            VStack(alignment: .trailing, spacing: Space.xs) {
                MoneyText(cents: holding.valueCents, colored: false, negativeIsLoss: true)
                    .redacted(reason: hideBalances ? .placeholder : [])
                GainText(gainCents: holding.isCash ? nil : holding.gainCents, percent: nil)
            }
        }
    }

    private func loadHoldings() async {
        guard let reader = model.reader else { return }
        do {
            let loaded = try await reader.read("/v1/investments", as: Investments.self)
            guard !Task.isCancelled else { return }
            holdings = .loaded(loaded)
        } catch {
            guard !Task.isCancelled else { return }
            holdings = .failed(errorMessage(error))
        }
    }

    private func loadHistory() async {
        guard let reader = model.reader else { return }
        let requested = range
        do {
            let loaded = try await reader.read("/v1/investments/history", query: requested.queryItems, as: NetWorthHistory.self)
            guard !Task.isCancelled, requested == range else { return }
            history = .loaded(loaded)
            loadedRange = requested
        } catch {
            guard !Task.isCancelled, requested == range else { return }
            history = .failed(errorMessage(error))
            loadedRange = requested
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
    @AppStorage("hideBalances") private var hideBalances = false

    var body: some View {
        if let gainCents {
            HStack(spacing: Space.s) {
                MoneyText(cents: gainCents, colored: !hideBalances, negativeIsLoss: !hideBalances)
                if let percent {
                    Text(percent.formatted(.percent.precision(.fractionLength(1))))
                        .textStyle(.subhead, color: hideBalances ? Palette.text : gainColor(gainCents))
                        .accessibilityHidden(hideBalances)
                }
            }
            .redacted(reason: hideBalances ? .placeholder : [])
        }
    }
}
