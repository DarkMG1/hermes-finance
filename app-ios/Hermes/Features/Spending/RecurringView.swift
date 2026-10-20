import HermesKit
import SwiftUI

enum RecurringFrequency {
    static let writable = ["weekly", "biweekly", "semi_monthly", "monthly", "annually"]

    static func label(_ frequency: String) -> String {
        switch frequency {
        case "weekly": "Weekly"
        case "biweekly": "Every 2 weeks"
        case "semi_monthly": "Twice a month"
        case "monthly": "Monthly"
        case "annually": "Yearly"
        default: "Irregular"
        }
    }
}

struct RecurringView: View {
    @Environment(AppModel.self) private var model
    @State private var list: RecurringList?
    @State private var error: String?
    @State private var showHidden = false
    @State private var editing: RecurringItem?

    var body: some View {
        List {
            if let list {
                Section("Due in the next 30 days") {
                    ForEach(list.upcoming) { item in row(item, subtitle: item.nextDate.map(DayText.display)) }
                    if list.upcoming.isEmpty { Text("Nothing due in the next 30 days").textStyle(.subhead, color: Palette.secondaryText) }
                }
                Section("All recurring · \(Money.format(list.monthlyTotalCents))/month") {
                    ForEach(list.items.filter { !$0.hidden && $0.ended != true }) { item in row(item, subtitle: subtitle(item)) }
                }
                let ended = list.items.filter { !$0.hidden && $0.ended == true }
                if !ended.isEmpty {
                    Section("Ended") { ForEach(ended) { item in row(item, subtitle: subtitle(item)) } }
                }
                let hidden = list.items.filter(\.hidden)
                if !hidden.isEmpty {
                    Section("Hidden") { ForEach(hidden) { item in row(item, subtitle: subtitle(item)).opacity(0.5) } }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            Section {
                InlineError(message: error)
                if list != nil { Toggle("Show hidden", isOn: $showHidden) }
            }
        }
        .themedForm()
        .navigationTitle("Recurring")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: showHidden) { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { item in
            RecurringSheet(item: item) {
                await load()
                // History edits keep the sheet open: show it the fresh item (same id, so it stays presented), unless it has closed
                if let id = editing?.id { editing = list?.items.first(where: { $0.id == id }) ?? editing }
            }
        }
    }

    private func row(_ item: RecurringItem, subtitle: String?) -> some View {
        Button { editing = item } label: { ListRow(title: item.name, subtitle: subtitle) { amountText(item) } }
            .buttonStyle(.plain)
    }

    private func subtitle(_ item: RecurringItem) -> String {
        var text = RecurringFrequency.label(item.frequency)
        if item.priceUpCents > 0 { text += " · ↑ \(Money.format(item.priceUpCents))" }
        if item.isNew { text += " · New" }
        return text
    }

    private func amountText(_ item: RecurringItem) -> some View {
        HStack(spacing: Space.xs) {
            if item.variable { Text("about").textStyle(.caption, color: Palette.secondaryText) }
            MoneyText(cents: item.amountCents, colored: false)
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        let requested = showHidden
        do {
            let loaded = try await client.recurring(includeHidden: requested)
            guard !Task.isCancelled, requested == showHidden else { return }
            list = loaded
            error = nil
        } catch {
            guard !Task.isCancelled, requested == showHidden else { return }
            self.error = errorMessage(error)
        }
    }
}
