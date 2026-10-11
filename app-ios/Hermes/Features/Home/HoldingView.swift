import HermesKit
import SwiftUI

struct HoldingView: View {
    let holding: Holding
    @Environment(AppModel.self) private var model
    @AppStorage("hideBalances") private var hideBalances = false
    @State private var range = NetWorthRange.month
    @State private var history: LoadState<NetWorthHistory> = .loading
    @State private var scrubbed: Date?
    @State private var loadedRange: NetWorthRange?

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
                }
            }
            Card {
                Text("Accounts").textStyle(.headline)
                ForEach(holding.accounts) { account in
                    ListRow(title: account.accountName, subtitle: holding.key == "CASH" || hideBalances ? nil : "\(sharesText(account.quantity)) shares") {
                        MoneyText(cents: account.valueCents, colored: false, negativeIsLoss: true)
                            .redacted(reason: hideBalances ? .placeholder : [])
                    }
                }
            }
        }
        .task(id: range) {
            if loadedRange != range { history = .loading }
            scrubbed = nil
            await load()
        }
        .refreshable { await load() }
    }

    @ViewBuilder private var header: some View {
        if case .loaded(let loaded) = history, let point = HistoryChart.point(at: scrubbed, in: loaded.value.points) {
            Text(DayText.display(point.date)).textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: point.netWorthCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hideBalances ? .placeholder : [])
        } else {
            Text(holding.name).textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: holding.valueCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hideBalances ? .placeholder : [])
            GainText(gainCents: holding.gainCents, percent: holding.gainPercent)
            if let price = holding.priceCents {
                LabeledContent("Price") { MoneyText(cents: price, colored: false) }
                    .textStyle(.body)
                    .redacted(reason: hideBalances ? .placeholder : [])
            }
            if let cost = holding.costBasisCents, holding.key != "CASH" {
                LabeledContent("Total cost") { MoneyText(cents: cost, colored: false) }
                    .textStyle(.body)
                    .redacted(reason: hideBalances ? .placeholder : [])
            }
        }
    }

    private func load() async {
        guard let reader = model.reader else { return }
        let requested = range
        do {
            let loaded = try await reader.read(holding.historyPath, query: requested.queryItems, as: NetWorthHistory.self)
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
