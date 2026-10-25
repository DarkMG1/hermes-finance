import Charts
import HermesKit
import SwiftUI

/// Daily values as an area and a line; dragging marks the chosen day. Net worth, Investments and Holding share it.
struct HistoryChart: View {
    let history: PreparedHistory
    @Binding var scrubbed: Date?
    @AppStorage("hideBalances") private var hideBalances = true
    @Environment(\.balancesRevealed) private var revealed

    var body: some View {
        let selected = history.point(at: scrubbed)
        Chart {
            ForEach(history.points) { point in
                let dollars = Double(point.value.netWorthCents) / 100
                AreaMark(x: .value("Day", point.day), yStart: .value("Floor", history.floor), yEnd: .value("Value", dollars))
                    .foregroundStyle(Palette.accent.opacity(0.15))
                LineMark(x: .value("Day", point.day), y: .value("Value", dollars))
                    .foregroundStyle(Palette.accent)
            }
            // while dragging, mark the day the header shows
            if let selected {
                RuleMark(x: .value("Day", selected.day))
                    .foregroundStyle(Palette.secondaryText)
                PointMark(x: .value("Day", selected.day), y: .value("Value", Double(selected.value.netWorthCents) / 100))
                    .foregroundStyle(Palette.accent)
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxis(hideBalances && !revealed ? .hidden : .automatic)
        .accessibilityHidden(hideBalances && !revealed)
        .chartXSelection(value: $scrubbed)
        .frame(height: Space.xxl * 7)
    }
}

/// Dates and missing prices for a chart whose range includes estimated days.
struct EstimatedFootnote: View {
    let through: String?
    var excluded: NetWorthHistory.Excluded?

    var body: some View {
        if let through {
            Text("Through \(DayText.date(through)?.formatted(.dateTime.month(.abbreviated).day().year()) ?? through): estimated from transactions.")
                .textStyle(.caption, color: Palette.secondaryText)
        }
        if let excluded {
            let date = DayText.date(excluded.through)?.formatted(.dateTime.month(.abbreviated).day().year()) ?? excluded.through
            let noun = excluded.positions == 1 ? "position" : "positions"
            Text("Through \(date): excludes \(excluded.positions) \(noun) with no price history.")
                .textStyle(.caption, color: Palette.secondaryText)
        }
    }
}
