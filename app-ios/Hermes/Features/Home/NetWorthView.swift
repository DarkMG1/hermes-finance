import HermesKit
import SwiftUI

struct NetWorthView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("hideBalances") private var hideBalances = false
    @State private var range = NetWorthRange.month
    @State private var state: LoadState<NetWorthHistory> = .loading
    @State private var scrubbed: Date?
    @State private var loadedRange: NetWorthRange?

    var body: some View {
        Screen(title: "Net worth") {
            Picker("Range", selection: $range) {
                ForEach(NetWorthRange.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                LastUpdated(loaded: loaded)
                let history = loaded.value
                Card { header(history) }
                if history.points.count < 2 {
                    Text("History starts today. Check back tomorrow.").textStyle(.subhead, color: Palette.secondaryText)
                } else {
                    Card { HistoryChart(points: history.points, scrubbed: $scrubbed) }
                    if let through = history.estimatedThrough {
                        Text("Through \(DayText.date(through)?.formatted(.dateTime.month(.abbreviated).day().year()) ?? through): estimated from transactions.")
                            .textStyle(.caption, color: Palette.secondaryText)
                    }
                }
            }
        }
        .task(id: range) {
            if loadedRange != range { state = .loading }
            scrubbed = nil
            await load()
        }
        .refreshable { await load() }
    }

    /// While dragging, the header shows the chosen day instead of today.
    @ViewBuilder private func header(_ history: NetWorthHistory) -> some View {
        if let point = HistoryChart.point(at: scrubbed, in: history.points) {
            Text(DayText.display(point.date)).textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: point.netWorthCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hideBalances ? .placeholder : [])
        } else {
            Text("Net worth").textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: history.currentCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hideBalances ? .placeholder : [])
            HStack(spacing: Space.s) {
                MoneyText(cents: history.changeCents, colored: !hideBalances, negativeIsLoss: !hideBalances)
                if let percent = history.changePercent {
                    Text(percent.formatted(.percent.precision(.fractionLength(1))))
                        .textStyle(.subhead, color: hideBalances ? Palette.text : changeColor(history.changeCents))
                        .accessibilityHidden(hideBalances)
                }
            }
            .redacted(reason: hideBalances ? .placeholder : [])
        }
    }

    private func changeColor(_ cents: Int) -> Color {
        cents < 0 ? Palette.loss : cents > 0 ? Palette.gain : Palette.text
    }

    private func load() async {
        guard let reader = model.reader else { return }
        let requested = range
        do {
            let loaded = try await reader.read("/v1/net-worth", query: requested.queryItems, as: NetWorthHistory.self)
            guard !Task.isCancelled, requested == range else { return }
            state = .loaded(loaded)
            loadedRange = requested
        } catch {
            guard !Task.isCancelled, requested == range else { return }
            state = .failed(errorMessage(error))
            loadedRange = requested
        }
    }
}
