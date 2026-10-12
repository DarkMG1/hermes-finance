import Charts
import HermesKit
import SwiftUI

/// Daily values as an area and a line; dragging marks the chosen day. Net worth, Investments and Holding share it.
struct HistoryChart: View {
    let points: [NetWorthPoint]
    @Binding var scrubbed: Date?
    @AppStorage("hideBalances") private var hideBalances = true

    var body: some View {
        let floor = Double(points.map(\.netWorthCents).min() ?? 0) / 100
        let selected = Self.point(at: scrubbed, in: points)
        Chart {
            ForEach(points, id: \.date) { point in
                let day = DayText.date(point.date) ?? .now
                let dollars = Double(point.netWorthCents) / 100
                AreaMark(x: .value("Day", day), yStart: .value("Floor", floor), yEnd: .value("Value", dollars))
                    .foregroundStyle(Palette.accent.opacity(0.15))
                LineMark(x: .value("Day", day), y: .value("Value", dollars))
                    .foregroundStyle(Palette.accent)
            }
            // while dragging, mark the day the header shows
            if let selected, let day = DayText.date(selected.date) {
                RuleMark(x: .value("Day", day))
                    .foregroundStyle(Palette.secondaryText)
                PointMark(x: .value("Day", day), y: .value("Value", Double(selected.netWorthCents) / 100))
                    .foregroundStyle(Palette.accent)
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxis(hideBalances ? .hidden : .automatic)
        .accessibilityHidden(hideBalances)
        .chartXSelection(value: $scrubbed)
        .frame(height: Space.xxl * 7)
    }

    /// The point nearest a scrubbed date.
    static func point(at date: Date?, in points: [NetWorthPoint]) -> NetWorthPoint? {
        guard let date else { return nil }
        return points.min { abs((DayText.date($0.date) ?? .now).timeIntervalSince(date)) < abs((DayText.date($1.date) ?? .now).timeIntervalSince(date)) }
    }
}

/// "Through Oct 10, 2026: estimated from transactions." under a chart whose range includes estimated days.
struct EstimatedFootnote: View {
    let through: String

    var body: some View {
        Text("Through \(DayText.date(through)?.formatted(.dateTime.month(.abbreviated).day().year()) ?? through): estimated from transactions.")
            .textStyle(.caption, color: Palette.secondaryText)
    }
}
