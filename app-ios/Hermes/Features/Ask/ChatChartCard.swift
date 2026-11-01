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
        let points = Array(chart.points.enumerated())
        // categories sit at their index, so a repeated label keeps its own point; labels thinned to about six so they don't run together
        let shown = Array(stride(from: 0, to: points.count, by: max(1, (points.count + 5) / 6)))
        return Group {
            if let dates = chart.dates {
                Chart(points, id: \.offset) { index, point in
                    LineMark(x: .value("Date", dates[index]), y: .value("Value", point.value)).foregroundStyle(Palette.accent)
                }
            } else {
                Chart(points, id: \.offset) { index, point in
                    LineMark(x: .value("Point", index), y: .value("Value", point.value)).foregroundStyle(Palette.accent)
                }
                .chartXScale(domain: 0...(points.count - 1))
                .chartXAxis {
                    AxisMarks(values: shown) { value in
                        AxisValueLabel { if let index = value.as(Int.self), points.indices.contains(index) { Text(points[index].element.label) } }
                    }
                }
            }
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
