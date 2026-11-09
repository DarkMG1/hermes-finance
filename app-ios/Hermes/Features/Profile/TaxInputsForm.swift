import HermesKit
import SwiftUI

/// What the owner enters for the shown year: tax inputs, next year's scenario (only on next year) and Roth IRA contributions.
struct TaxEntriesSections: View {
    @Environment(AppModel.self) private var model
    let year: Int
    let inputs: TaxInputs?
    let scenario: TaxScenario?
    let roth: [RothContribution]
    /// reloads the projection, which the entries change
    let onChange: () async -> Void
    @State private var addingRoth = false

    var body: some View {
        Section("Entered for \(String(year))") {
            if let inputs {
                // next year's 401(k) is the scenario's
                let fields = scenario == nil ? Self.inputFields : Self.inputFields.filter { $0.key != "k401Cents" }
                EditRow(title: "Tax inputs \(String(year))", fields: fields, original: inputs.fields,
                        row: ListRow(title: "Tax inputs", subtitle: Self.summary(fields, inputs.fields))) { body, key in
                    _ = try await model.client?.putTaxInputs(year: year, body, idempotencyKey: key)
                    await onChange()
                }
            }
            if let scenario {
                EditRow(title: "Scenario \(String(year))", fields: Self.scenarioFields, original: scenario.fields,
                        row: ListRow(title: "Scenario", subtitle: Self.summary(Self.scenarioFields, scenario.fields))) { body, key in
                    _ = try await model.client?.putTaxScenario(year: year, body, idempotencyKey: key)
                    await onChange()
                }
            }
        }
        Section("Roth IRA contributions for \(String(year))") {
            ForEach(roth) { RothRow(contribution: $0, onChange: onChange) }
            Button("Add contribution") { addingRoth = true }
        }
        .sheet(isPresented: $addingRoth) {
            EditForm(title: "Roth IRA contribution", fields: Self.rothFields, original: RothDraft()) { draft, key in
                guard let date = draft.date, let amount = draft.amountCents else { return }
                _ = try await model.client?.addRothContribution(
                    RothContributionBody(date: date, amountCents: amount, taxYear: Self.rothYear(date: date, shown: year)), idempotencyKey: key)
                await onChange()
            }
        }
    }

    /// A deposit counts for its own year, except one from Jan 1 to Apr 15 added on the year before's screen.
    static func rothYear(date: String, shown: Int) -> Int {
        let dated = Int(date.prefix(4)) ?? shown
        return dated == shown + 1 && RothRow.early(date) ? shown : dated
    }

    private static func summary<B>(_ fields: [DraftField<B>], _ body: B) -> String {
        let parts = fields.compactMap { f in f.text(body).isEmpty ? nil : "\(f.label) \(f.text(body))" }
        return parts.isEmpty ? "Nothing entered" : parts.joined(separator: " · ")
    }

    static let inputFields: [DraftField<TaxInputsBody>] = [
        .init(key: "tuitionCents", label: "Tuition and required fees", kind: .money(\.tuitionCents)),
        .init(key: "scholarshipsCents", label: "Scholarships and grants", kind: .money(\.scholarshipsCents)),
        .init(key: "studentLoanInterestCents", label: "Student loan interest", kind: .money(\.studentLoanInterestCents)),
        .init(key: "k401Cents", label: "401(k) contributions", kind: .money(\.k401Cents)),
    ]

    static let scenarioFields: [DraftField<TaxScenarioBody>] = [
        .init(key: "moveDate", label: "Move date", kind: .date(\.moveDate)),
        .init(key: "moveTo", label: "Move to (state code)", kind: .code(\.moveTo)),
        .init(key: "relocationCents", label: "Relocation", kind: .money(\.relocationCents)),
        .init(key: "bonusCents", label: "Bonus", kind: .money(\.bonusCents)),
        .init(key: "k401Cents", label: "401(k) contributions", kind: .money(\.k401Cents)),
        .init(key: "rothCents", label: "Roth IRA contributions", kind: .money(\.rothCents)),
    ]

    struct RothDraft: Equatable {
        var date: String?
        var amountCents: Int?
    }

    private static let rothFields: [DraftField<RothDraft>] = [
        .init(key: "date", label: "Date", kind: .date(\.date), required: true),
        .init(key: "amountCents", label: "Amount", kind: .money(\.amountCents), required: true),
    ]
}

/// A contribution: its year can move to the one before when it's dated Jan 1 to Apr 15; swipe to delete (a suggested one is dismissed).
private struct RothRow: View {
    @Environment(AppModel.self) private var model
    let contribution: RothContribution
    let onChange: () async -> Void
    @State private var writes = WriteGuard()
    @State private var error: String?

    static func early(_ date: String) -> Bool { date.dropFirst(5) <= "04-15" }

    var body: some View {
        let dated = Int(contribution.date.prefix(4)) ?? contribution.taxYear
        VStack(alignment: .leading, spacing: Space.xs) {
            ListRow(title: DayText.display(contribution.date), subtitle: contribution.transactionId == nil ? nil : "From a transfer into the account") {
                MoneyText(cents: contribution.amountCents, colored: false)
            }
            if Self.early(contribution.date) {
                Picker("Counts for", selection: Binding { contribution.taxYear } set: { y in Task { await move(to: y) } }) {
                    Text(String(dated - 1)).tag(dated - 1)
                    Text(String(dated)).tag(dated)
                }
            }
        }
        .deleteSwipe("Delete this contribution?") { client, key in
            try await client.deleteRothContribution(id: contribution.id, idempotencyKey: key)
            await onChange()
        }
        .alert(error ?? "", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {}
    }

    private func move(to taxYear: Int) async {
        guard let client = model.client, taxYear != contribution.taxYear else { return }
        do {
            _ = try await client.setRothContributionYear(id: contribution.id, taxYear: taxYear, idempotencyKey: writes.key)
            writes.didSucceed()
            await onChange()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the change. Pick the year again to retry; it won't be applied twice." : errorMessage(error)
        }
    }
}
