import HermesKit
import SwiftUI

struct NetWorthView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("hideBalances") private var hideBalances = true
    @State private var range = NetWorthRange.month
    @State private var state: LoadState<NetWorthHistory> = .loading
    @State private var scrubbed: Date?
    @State private var chart = PreparedHistory(points: [])
    /// The range the shown history was read for: its change line is hidden while another range loads.
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
                    Card { HistoryChart(history: chart, scrubbed: $scrubbed) }
                    EstimatedFootnote(through: history.estimatedThrough, excluded: history.excluded)
                }
            }
        }
        .task(id: range) {
            // an old error would read as this range's; the old chart stays until the new one lands
            if case .failed = state { state = .loading }
            scrubbed = nil
            await load()
        }
        .refreshable { await load() }
    }

    /// While dragging, the header shows the chosen day instead of today.
    @ViewBuilder private func header(_ history: NetWorthHistory) -> some View {
        if let point = chart.point(at: scrubbed)?.value {
            Text(DayText.display(point.date)).textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: point.netWorthCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hideBalances ? .placeholder : [])
        } else {
            Text("Net worth").textStyle(.subhead, color: Palette.secondaryText)
            MoneyText(cents: history.currentCents, style: .display, colored: false, negativeIsLoss: true)
                .redacted(reason: hideBalances ? .placeholder : [])
            GainText(gainCents: history.changeCents, percent: history.changePercent)
                .opacity(loadedRange == range ? 1 : 0)
                .accessibilityHidden(loadedRange != range)
        }
    }

    private func load() async {
        guard let reader = model.reader else { return }
        let requested = range
        do {
            let loaded = try await reader.read("/v1/net-worth", query: requested.queryItems, as: NetWorthHistory.self)
            guard !Task.isCancelled, requested == range else { return }
            chart = PreparedHistory(points: loaded.value.points)
            state = .loaded(loaded)
            loadedRange = requested
        } catch {
            guard !Task.isCancelled, requested == range else { return }
            state = .failed(errorMessage(error))
        }
    }
}
