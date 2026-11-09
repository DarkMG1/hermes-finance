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
    @State private var addingGrant = false
    @State private var addingW4 = false
    @State private var addingStateW4 = false

    var body: some View {
        List {
            InlineError(message: error)
            if let detail {
                Section("Pay") { pay(detail.job.fields) }
                Section("Grants") {
                    ForEach(detail.grants) { grant in
                        EditRow(title: "Grant", fields: ProfileDraftForm.grantFields, original: grant.fields,
                                row: ListRow(title: Self.grantTitle(grant.fields), subtitle: Self.schedule(grant.fields))) { body, key in
                            _ = try await model.client?.patchGrant(jobId: id, id: grant.id, body: body, from: grant.fields, idempotencyKey: key)
                            await load()
                        }
                        .deleteSwipe("Delete this grant?") { client, key in
                            try await client.deleteGrant(jobId: id, id: grant.id, idempotencyKey: key)
                            await load()
                        }
                    }
                    Button("Add grant") { addingGrant = true }
                }
                if !detail.grants.isEmpty {
                    Section("Next vests") {
                        if detail.nextVests.isEmpty { Text("Fully vested").textStyle(.subhead, color: Palette.secondaryText) }
                        ForEach(detail.nextVests, id: \.self) { vest in
                            LabeledContent(DayText.display(vest.date), value: Self.amount(shares: vest.shares, valueCents: vest.valueCents))
                        }
                    }
                }
                Section("Withholding") {
                    if let w4 = detail.w4 {
                        EditRow(title: "W-4", fields: ProfileDraftForm.w4Fields, original: w4,
                                row: ListRow(title: Self.w4Title(w4), subtitle: Self.w4Detail(w4))) { body, key in
                            _ = try await model.client?.putW4(jobId: id, body: body, idempotencyKey: key)
                            await load()
                        }
                        .deleteSwipe("Delete this W-4?") { client, key in
                            try await client.deleteW4(jobId: id, idempotencyKey: key)
                            await load()
                        }
                    } else {
                        Button("Add W-4") { addingW4 = true }
                    }
                    ForEach(detail.stateW4s, id: \.state) { form in
                        EditRow(title: "State form", fields: ProfileDraftForm.stateW4Fields, original: form,
                                row: ListRow(title: "\(form.state ?? "State") form", subtitle: Self.stateW4Detail(form))) { body, key in
                            guard let client = model.client else { return }
                            _ = try await client.putStateW4(jobId: id, body: body, idempotencyKey: key)
                            // a changed state code is a different form: the old one goes
                            if let old = form.state, old != body.state { try await client.deleteStateW4(jobId: id, state: old, idempotencyKey: key + "-old") }
                            await load()
                        }
                        .deleteSwipe("Delete this state form?") { client, key in
                            try await client.deleteStateW4(jobId: id, state: form.state ?? "", idempotencyKey: key)
                            await load()
                        }
                    }
                    Button("Add state form") { addingStateW4 = true }
                }
                if !detail.stubs.isEmpty {
                    Section("Pay stubs") { ForEach(detail.stubs) { PayStubRow(stub: $0) { await load() } } }
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
        .sheet(isPresented: $addingGrant) {
            EditForm(title: "New grant", fields: ProfileDraftForm.grantFields, original: Self.newGrant) { body, key in
                _ = try await model.client?.createGrant(jobId: id, body: body, idempotencyKey: key)
                await load()
            }
        }
        .sheet(isPresented: $addingStateW4) {
            EditForm(title: "State form", fields: ProfileDraftForm.stateW4Fields, original: StateW4Body()) { body, key in
                _ = try await model.client?.putStateW4(jobId: id, body: body, idempotencyKey: key)
                await load()
            }
        }
        .sheet(isPresented: $addingW4) {
            EditForm(title: "W-4", fields: ProfileDraftForm.w4Fields, original: W4Body()) { body, key in
                _ = try await model.client?.putW4(jobId: id, body: body, idempotencyKey: key)
                await load()
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private static func w4Title(_ w: W4Body) -> String {
        w.exempt == true ? "Exempt" : ProfileDraftForm.w4Statuses.first { $0.value == w.filingStatus }?.label ?? "W-4"
    }

    private static func w4Detail(_ w: W4Body) -> String? {
        let parts = [
            w.signedOn.map { "Signed \(DayText.display($0))" },
            w.multipleJobs == true ? "Multiple jobs" : nil,
            w.extraWithholdingCents.flatMap { $0 > 0 ? "\(Money.format($0)) extra a paycheck" : nil },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func stateW4Detail(_ w: StateW4Body) -> String? {
        // lines 1a and 1b together: the total payroll uses
        let claimed = [w.allowances, w.additionalAllowances].compactMap { $0 }
        let allowances = claimed.reduce(0, +)
        let parts = [
            w.exempt == true ? "Exempt" : nil,
            claimed.isEmpty ? nil : allowances == 1 ? "1 allowance" : "\(allowances) allowances",
            w.extraWithholdingCents.flatMap { $0 > 0 ? "\(Money.format($0)) extra a paycheck" : nil },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder private func pay(_ job: CreateJobBody) -> some View {
        LabeledContent("Status", value: ProfileView.statuses.first { $0.value == job.status }?.label ?? job.status ?? "")
        if let title = job.title { LabeledContent("Title", value: title) }
        if let start = job.startDate { LabeledContent("Start", value: DayText.display(start)) }
        if let end = job.endDate { LabeledContent("End", value: DayText.display(end)) }
        if let base = job.baseCents { LabeledContent("Base pay a year") { MoneyText(cents: base, colored: false) } }
        if let hourly = job.hourlyCents { LabeledContent("Hourly rate") { MoneyText(cents: hourly, colored: false) } }
        if let hours = job.hoursPerWeek { LabeledContent("Hours per week", value: hours.formatted()) }
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

    static let fields: [DraftField<CreateJobBody>] =
        [.init(key: "status", label: "Status", kind: .choice(\.status, ProfileView.statuses), required: true)] + ProfileDraftForm.jobFields

    private static let newGrant = { var g = GrantBody(); g.kind = "rsu"; return g }()

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

/// A W-2 or 1099: tap to edit, swipe to delete.
struct TaxFormRow: View {
    @Environment(AppModel.self) private var model
    let form: TaxForm
    let onChange: () async -> Void

    var body: some View {
        let kind = ProfileDraftForm.formKinds.first { $0.value == form.kind }?.label ?? "Form"
        EditRow(title: kind, fields: ProfileDraftForm.formFields, original: form.fields,
                row: ListRow(title: [kind, form.year.map(String.init)].compactMap { $0 }.joined(separator: " "), subtitle: form.payer) {
                    if let amount = form.amountCents { MoneyText(cents: amount, colored: false) }
                }) { body, key in
            _ = try await model.client?.patchTaxForm(id: form.id, body: body, from: form.fields, idempotencyKey: key)
            await onChange()
        }
        .deleteSwipe("Delete this form?") { client, key in
            try await client.deleteTaxForm(id: form.id, idempotencyKey: key)
            await onChange()
        }
    }
}

/// A pay stub: tap to edit, link or unlink its deposits, swipe to delete. `fields` may add a job choice.
struct PayStubRow: View {
    @Environment(AppModel.self) private var model
    let stub: PayStub
    var fields = ProfileDraftForm.stubFields
    let onChange: () async -> Void
    @State private var linking = false

    var body: some View {
        HStack {
            EditRow(title: "Pay stub", fields: fields, original: stub.fields, check: \.balanceProblem,
                    row: ListRow(title: stub.payDate.map(DayText.display) ?? "Pay stub",
                                 subtitle: [stub.netCents.map { "Net \(Money.format($0))" }, stub.transactionIds.isEmpty ? nil : "Linked"]
                                    .compactMap { $0 }.joined(separator: " · "))) { body, key in
                _ = try await model.client?.patchPayStub(id: stub.id, body: body, from: stub.fields, idempotencyKey: key)
                await onChange()
            }
            if stub.transactionIds.isEmpty {
                Button("Link…") { linking = true }.buttonStyle(.borderless)
            } else {
                UnlinkButton(stub: stub, onUnlinked: onChange)
            }
        }
        .deleteSwipe("Delete this pay stub?") { client, key in
            try await client.deletePayStub(id: stub.id, idempotencyKey: key)
            await onChange()
        }
        .sheet(isPresented: $linking, onDismiss: { Task { await onChange() } }, content: { PayStubLinkSheet(stub: stub) })
    }
}

/// Unlinks a stub's deposits after a confirmation.
private struct UnlinkButton: View {
    @Environment(AppModel.self) private var model
    let stub: PayStub
    let onUnlinked: () async -> Void
    @State private var confirming = false
    @State private var writes = WriteGuard()
    @State private var error: String?

    var body: some View {
        Button("Unlink") { confirming = true }
            .buttonStyle(.borderless)
            .confirmationDialog(stub.transactionIds.count > 1 ? "Unlink this paycheck's deposits?" : "Unlink this paycheck's deposit?",
                                isPresented: $confirming, titleVisibility: .visible) {
                Button("Unlink", role: .destructive) { Task { await unlink() } }
            }
            .alert(error ?? "", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {}
    }

    private func unlink() async {
        guard let client = model.client else { return }
        do {
            _ = try await client.linkPayStub(id: stub.id, transactionIds: [], idempotencyKey: writes.key)
            writes.didSucceed()
            await onUnlinked()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the unlink. Unlink again to retry; it won't be applied twice." : errorMessage(error)
        }
    }
}
