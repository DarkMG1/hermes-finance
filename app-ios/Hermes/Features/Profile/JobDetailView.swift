import HermesKit
import SwiftUI

struct JobDetailView: View {
    @Environment(AppModel.self) private var model
    let id: String
    /// the job list behind shows names and statuses
    let onChange: () async -> Void
    @State private var detail: JobDetail?
    @State private var error: String?
    @State private var editing = false
    @State private var linking: PayStub?

    var body: some View {
        List {
            InlineError(message: error)
            if let detail {
                Section("Pay") { pay(detail.job.fields) }
                if !detail.grants.isEmpty {
                    Section("Grants") {
                        ForEach(detail.grants) { grant in
                            ListRow(title: Self.grantTitle(grant.fields), subtitle: Self.schedule(grant.fields))
                                .deleteSwipe("Delete this grant?") { client, key in
                                    try await client.deleteGrant(jobId: id, id: grant.id, idempotencyKey: key)
                                    await load()
                                }
                        }
                    }
                    Section("Next vests") {
                        if detail.nextVests.isEmpty { Text("Fully vested").textStyle(.subhead, color: Palette.secondaryText) }
                        ForEach(detail.nextVests, id: \.self) { vest in
                            LabeledContent(DayText.display(vest.date), value: Self.amount(shares: vest.shares, valueCents: vest.valueCents))
                        }
                    }
                }
                if !detail.stubs.isEmpty {
                    Section("Pay stubs") {
                        ForEach(detail.stubs) { stub in
                            ListRow(title: stub.payDate.map(DayText.display) ?? "Pay stub", subtitle: stub.netCents.map { "Net \(Money.format($0))" }) {
                                if stub.transactionId != nil {
                                    Text("Linked").textStyle(.subhead, color: Palette.secondaryText)
                                } else {
                                    Button("Link…") { linking = stub }.buttonStyle(.borderless)
                                }
                            }
                            .deleteSwipe("Delete this pay stub?") { client, key in
                                try await client.deletePayStub(id: stub.id, idempotencyKey: key)
                                await load()
                            }
                        }
                    }
                }
                if !detail.forms.isEmpty {
                    Section("W-2s and 1099s") { ForEach(detail.forms) { TaxFormRow(form: $0) { await load() } } }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .themedForm()
        .navigationTitle(detail?.employer ?? "Job")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if detail != nil { ToolbarItem(placement: .topBarTrailing) { Button("Edit") { editing = true } } }
        }
        .sheet(isPresented: $editing) {
            if let job = detail?.job {
                EditForm(title: "Job", fields: Self.fields, original: job.fields) { body, key in
                    guard let client = model.client else { return }
                    _ = try await client.patchJob(id: id, body: body, from: job.fields, idempotencyKey: key)
                    await load()
                    await onChange()
                }
            }
        }
        .sheet(item: $linking, onDismiss: { Task { await load() } }, content: { PayStubLinkSheet(stub: $0) })
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private func pay(_ job: CreateJobBody) -> some View {
        LabeledContent("Status", value: ProfileView.statuses.first { $0.value == job.status }?.label ?? job.status ?? "")
        if let title = job.title { LabeledContent("Title", value: title) }
        if let start = job.startDate { LabeledContent("Start", value: DayText.display(start)) }
        if let end = job.endDate { LabeledContent("End", value: DayText.display(end)) }
        if let base = job.baseCents { LabeledContent("Base pay a year") { MoneyText(cents: base, colored: false) } }
        if let bonus = job.bonusTargetPct { LabeledContent("Bonus target", value: (bonus / 100).formatted(.percent)) }
        if let signing = job.signingBonusCents { LabeledContent("Signing bonus") { MoneyText(cents: signing, colored: false) } }
        if let relocation = job.relocationCents { LabeledContent("Relocation") { MoneyText(cents: relocation, colored: false) } }
        if let note = job.note { Text(note).textStyle(.subhead, color: Palette.secondaryText) }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            detail = try await client.job(id: id)
            error = nil
        } catch {
            self.error = errorMessage(error)
        }
    }

    private static let fields: [DraftField<CreateJobBody>] =
        [.init(key: "status", label: "Status", kind: .choice(\.status, ProfileView.statuses))] + ProfileDraftForm.jobFields

    static func amount(shares: Double?, valueCents: Int?) -> String {
        [shares.map { "\($0.formatted()) shares" }, valueCents.map { Money.format($0) }].compactMap { $0 }.joined(separator: " · ")
    }

    private static func grantTitle(_ g: GrantBody) -> String {
        let kind = g.kind == "option" ? "Option" : "RSU"
        return [kind, amount(shares: g.shares, valueCents: g.valueCents), g.strikeCents.map { "strike \(Money.format($0))" }]
            .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }

    private static func schedule(_ g: GrantBody) -> String? {
        let parts = [
            g.grantDate.map { "Granted \(DayText.display($0))" },
            g.vestMonths.map { "over \($0) months" },
            g.vestEveryMonths.map { "every \($0)" },
            g.cliffMonths.flatMap { $0 > 0 ? "\($0)-month cliff" : nil },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// A W-2 or 1099, swipe to delete.
struct TaxFormRow: View {
    let form: TaxForm
    let onDeleted: () async -> Void

    var body: some View {
        let kind = ProfileDraftForm.formKinds.first { $0.value == form.kind }?.label ?? "Form"
        ListRow(title: [kind, form.year.map(String.init)].compactMap { $0 }.joined(separator: " "), subtitle: form.payer) {
            if let amount = form.amountCents { MoneyText(cents: amount, colored: false) }
        }
        .deleteSwipe("Delete this form?") { client, key in
            try await client.deleteTaxForm(id: form.id, idempotencyKey: key)
            await onDeleted()
        }
    }
}
