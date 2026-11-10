import HermesKit
import SwiftUI

/// The projected returns for an open year: the combined result, a tab per return, ways to save, the assumptions, and what the owner
/// enters for that year.
struct TaxView: View {
    @Environment(AppModel.self) private var model
    /// nil: the server's first open year
    @State private var year: Int?
    @State private var jurisdiction = "federal"
    @State private var projection: TaxProjection?
    @State private var inputs: TaxInputs?
    @State private var scenario: TaxScenario?
    @State private var roth: [RothContribution] = []
    /// every open year's, as Home counts them
    @State private var headsUp: [TaxAdvice] = []
    @State private var error: String?

    var body: some View {
        List {
            InlineError(message: error)
            if let projection {
                if !headsUp.isEmpty { AdviceSection(title: "Heads up", items: headsUp) }
                // after a failed switch the picker shows the year whose figures are on screen; picking it again retries
                TaxResultSection(projection: projection, year: Binding { error == nil ? year ?? projection.year : projection.year } set: { y in
                    if y == year { Task { await load() } } else { year = y }
                }, jurisdiction: $jurisdiction)
                if !projection.waysToSave.isEmpty { AdviceSection(title: "Ways to save", items: projection.waysToSave) }
                if !projection.assumptions.isEmpty {
                    Section("Assumptions") {
                        ForEach(projection.assumptions.indices, id: \.self) {
                            Text(projection.assumptions[$0]).textStyle(.subhead, color: Palette.secondaryText)
                        }
                    }
                }
                TaxEntriesSections(year: projection.year, inputs: inputs, scenario: scenario, roth: roth) { await load() }
                Section { NavigationLink { TaxLotsView() } label: { Text("Lots and cost basis") } }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .themedForm()
        .navigationTitle("Taxes")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: year) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            let p = try await client.taxProjection(year: year)
            // the scenario is next year's: the last open one
            async let s = p.year == p.openYears.last ? client.taxScenario(year: p.year) : nil
            async let i = client.taxInputs(year: p.year)
            async let r = client.rothContributions(taxYear: p.year)
            async let h = client.taxHeadsUp(unlocked: true)
            (projection, inputs, scenario, roth) = try await (p, i, s, r)
            error = nil
            // the figures show first; a failure shows no items, like Home
            let items = (try? await h)?.items
            if !Task.isCancelled { headsUp = items ?? [] }
        } catch {
            guard !Task.isCancelled else { return }
            self.error = errorMessage(error)
        }
    }
}

/// The combined result, the year switch, a tab per return and its lines.
private struct TaxResultSection: View {
    let projection: TaxProjection
    @Binding var year: Int
    @Binding var jurisdiction: String
    @State private var shown: TaxLine?

    var body: some View {
        let balance = projection.combinedBalanceCents
        let ret = projection.returns.first { $0.jurisdiction == jurisdiction } ?? projection.returns.first
        Section {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Projected, all returns").textStyle(.caption, color: Palette.secondaryText)
                Text(balance == 0 ? "Even" : balance < 0 ? "You'll owe \(Money.format(-balance))" : "Refund \(Money.format(balance))")
                    .textStyle(.title, color: balance == 0 ? Palette.text : balance < 0 ? Palette.loss : Palette.gain)
                    .monospacedDigit()
                if let reason = projection.incompleteReason {
                    Text("Not complete: \(reason)").textStyle(.caption, color: Palette.loss)
                }
                if let met = projection.meetsSafeHarbor {
                    Text(met ? "Withholding meets the safe harbor" : "Below the safe harbor: a penalty is possible")
                        .textStyle(.caption, color: met ? Palette.secondaryText : Palette.loss)
                }
            }
            if projection.openYears.count > 1 {
                Picker("Year", selection: $year) {
                    ForEach(projection.openYears, id: \.self) { Text(String($0)).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            Picker("Return", selection: Binding { ret?.jurisdiction ?? "" } set: { jurisdiction = $0 }) {
                ForEach(projection.returns, id: \.jurisdiction) { Text(Self.name($0.jurisdiction)).tag($0.jurisdiction) }
            }
            .pickerStyle(.segmented)
        }
        if let ret {
            Section(Self.name(ret.jurisdiction)) {
                if ret.supported {
                    ForEach(ret.lines, id: \.key) { line in
                        Button { shown = line } label: {
                            ListRow(title: line.label, subtitle: line.assumption == nil ? nil : "Estimated") {
                                MoneyText(cents: line.cents, colored: false)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    ForEach(ret.lines, id: \.key) { Text($0.assumption ?? $0.label).textStyle(.subhead, color: Palette.secondaryText) }
                }
            }
            .sheet(isPresented: Binding { shown != nil } set: { if !$0 { shown = nil } }) {
                if let shown { TaxLineSheet(line: shown) }
            }
        }
    }

    static func name(_ jurisdiction: String) -> String { jurisdiction == "federal" ? "Federal" : jurisdiction }
}

/// Where a line's figure comes from and what it assumes.
private struct TaxLineSheet: View {
    @Environment(\.dismiss) private var dismiss
    let line: TaxLine

    var body: some View {
        Sheet(title: line.label, dirty: false, onCancel: { dismiss() }, onSave: nil) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                LabeledContent("Amount") { MoneyText(cents: line.cents, colored: false) }
                LabeledContent("Source", value: line.source)
            }
            if let assumption = line.assumption {
                Section("Estimated") { Text(assumption).textStyle(.subhead) }
            }
        }
        .presentationDetents([.medium])
    }
}

/// Each item opens Ask with its question typed in, not sent.
private struct AdviceSection: View {
    @Environment(AppModel.self) private var model
    let title: String
    let items: [TaxAdvice]

    var body: some View {
        Section(title) {
            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                Button { model.askDraft = item.askPrompt } label: {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(item.title).textStyle(.headline)
                        Text(item.detail).textStyle(.subhead, color: Palette.secondaryText)
                        if let savings = item.savingsCents {
                            Text("about \(Money.format(savings)) less tax").textStyle(.caption, color: Palette.gain)
                        }
                        if let due = item.dueDate { Text("Due \(due)").textStyle(.caption, color: Palette.secondaryText) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
