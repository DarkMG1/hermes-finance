import Charts
import HermesKit
import SwiftUI

struct SpendingView: View {
    @Environment(AppModel.self) private var model
    @State private var period = SpendingPeriod.current(today: DayText.ymd(.now))
    @State private var state: LoadState<Spending> = .loading

    var body: some View {
        Screen(title: "Spending") {
            Picker("Period", selection: Binding(get: { period.kind }, set: { period = period.with(kind: $0) })) {
                Text("Month").tag(SpendingPeriod.Kind.month)
                Text("Year").tag(SpendingPeriod.Kind.year)
            }
            .pickerStyle(.segmented)
            HStack {
                Button { period = period.previous() } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel("Previous period")
                Spacer()
                Text(period.title).textStyle(.headline)
                Spacer()
                Button { period = period.next() } label: { Image(systemName: "chevron.right") }
                    .accessibilityLabel("Next period")
                    .disabled(!period.canGoNext(today: DayText.ymd(.now)))
            }
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                LastUpdated(loaded: loaded)
                Card {
                    Text("Spent").textStyle(.subhead, color: Palette.secondaryText)
                    MoneyText(cents: loaded.value.totalCents, style: .display, colored: false)
                }
                if loaded.value.categories.isEmpty {
                    Text("No spending in this period").textStyle(.subhead, color: Palette.secondaryText)
                } else {
                    Card {
                        let top = Array(loaded.value.categories.prefix(8))
                        Chart(top, id: \.name) { category in
                            BarMark(x: .value("Spent", Double(category.spentCents) / 100), y: .value("Category", category.name))
                                .foregroundStyle(Palette.accent)
                        }
                        .chartXAxis(.hidden)
                        .frame(height: CGFloat(top.count) * 32)
                    }
                    Card {
                        ForEach(loaded.value.categories, id: \.name) { category in
                            ListRow(title: category.name) { MoneyText(cents: category.spentCents, colored: false) }
                        }
                    }
                }
            }
        }
        .task(id: period) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            let loaded = try await reader.read("/v1/spending", query: period.queryItems, as: Spending.self)
            guard !Task.isCancelled else { return }
            state = .loaded(loaded)
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(errorMessage(error))
        }
    }
}
