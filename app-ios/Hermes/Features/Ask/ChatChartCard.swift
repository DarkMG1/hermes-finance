import Charts
import HermesKit
import SwiftUI

/// A chart Claude drew with show_chart, shown above its answer.
struct ChatChartCard: View {
    let chart: ChatChart

    var body: some View {
        Card {
            Text(chart.title).textStyle(.headline)
            switch chart.kind {
            case .bar: bars
            case .line: line
            }
        }
    }

    /// Plain rows, not Swift Charts: on device its category axis drew each name half a row above its bar (as on Spending).
    private var bars: some View {
        let most = chart.points.map { abs($0.value) }.max() ?? 0
        return Grid(alignment: .leading, horizontalSpacing: Space.s, verticalSpacing: Space.s) {
            ForEach(Array(chart.points.enumerated()), id: \.offset) { _, point in
                GridRow {
                    Text(point.label).textStyle(.caption, color: Palette.secondaryText).lineLimit(1)
                    GeometryReader { bar in
                        RoundedRectangle(cornerRadius: Space.xs)
                            .fill(point.value < 0 ? Palette.loss : Palette.accent)
                            .frame(width: most > 0 ? bar.size.width * abs(point.value) / most : 0)
                    }
                    .frame(height: Space.l + Space.s)
                    Text(chart.format(point.value)).textStyle(.caption).monospacedDigit().gridColumnAlignment(.trailing)
                }
            }
        }
    }

    private var line: some View {
        let dates = chart.dates
        // category labels thinned to about six, so they don't run together
        let step = max(1, (chart.points.count + 5) / 6)
        let shown = chart.points.enumerated().filter { $0.offset % step == 0 }.map(\.element.label)
        return Chart(Array(chart.points.enumerated()), id: \.offset) { index, point in
            if let dates {
                LineMark(x: .value("Date", dates[index]), y: .value("Value", point.value)).foregroundStyle(Palette.accent)
            } else {
                LineMark(x: .value("Label", point.label), y: .value("Value", point.value)).foregroundStyle(Palette.accent)
            }
        }
        .chartXAxis {
            if dates == nil { AxisMarks(values: shown) } else { AxisMarks() }
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine()
                AxisValueLabel { if let number = value.as(Double.self) { Text(chart.format(number)) } }
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .frame(height: Space.xxl * 6)
    }
}
