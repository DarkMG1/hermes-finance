import HermesKit
import SwiftUI

/// Review what was read (or enter it by hand), then save it. A pay stub then offers the deposits it matches; an offer saves its job
/// (status offered) and then each grant.
struct ProfileDraftForm: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let kind: ProfileKind
    let uncertain: Set<String>
    /// the employer printed on a pay stub or W-4
    private let employer: String?
    /// which of several pay stubs read off one file this is, and how many
    private let step: (Int, Int)?
    /// on to the next of those stubs, with the job picked on this one
    private let next: ((String?) -> Void)?
    /// shown above the fields, such as stubs skipped as already saved
    private let note: String?
    /// the read's kept pages, saved with the record
    private let documentId: String?
    /// the saved record the read matched: saved as an update of it
    private let recordId: String?
    /// a re-read of a kept document, not a fresh scan
    private let reread: Bool
    /// after any write that saved
    private let onSaved: (() -> Void)?

    private struct GrantRow: Identifiable {
        let id = UUID()
        var texts: [String: String]
    }

    @State private var texts: [String: String]
    @State private var grants: [GrantRow]
    @State private var jobs: [Job] = []
    @State private var jobsError: String?
    @State private var jobId: String?
    /// the picker was set, from the matched record or by hand; until then an update keeps the record's job
    @State private var jobPicked = false
    @State private var writes = WriteGuard()
    @State private var busy = false
    @State private var error: String?
    /// an offer's job and grants already saved, so a retry carries on from the next one
    @State private var savedJobId: String?
    @State private var savedGrants = 0
    @State private var stub: PayStub?
    /// nil until fetched
    @State private var record: Record?

    /// The record a read matched as saved now, fetched once so a retry sends the same patch; gone: the read saves as a new one.
    private enum Record {
        case form(TaxForm), stub(PayStub), job(Job), gone
        var form: TaxForm? { if case .form(let f) = self { f } else { nil } }
        var stub: PayStub? { if case .stub(let s) = self { s } else { nil } }
        var job: Job? { if case .job(let j) = self { j } else { nil } }
        var gone: Bool { if case .gone = self { true } else { false } }
    }

    init(kind: ProfileKind, draft: ProfileDraft, uncertain: Set<String>, step: (Int, Int)? = nil, jobId: String? = nil, note: String? = nil,
         documentId: String? = nil, recordId: String? = nil, reread: Bool = false, onSaved: (() -> Void)? = nil, next: ((String?) -> Void)? = nil) {
        self.kind = kind
        self.uncertain = uncertain
        self.step = step
        self.note = note
        self.documentId = documentId
        self.recordId = recordId
        self.reread = reread
        self.onSaved = onSaved
        self.next = next
        // a W-4's record is its job, a state form's "<job id>:<state>"
        _jobId = State(initialValue: jobId ?? recordId.flatMap { [.w4, .stateW4].contains(kind) ? String($0.prefix { $0 != ":" }) : nil })
        var employer: String?
        var grants: [GrantRow] = []
        let texts: [String: String] = switch draft {
        case .taxReturn(let b): DraftField.texts(Self.returnFields, b)
        case .taxForm(let b): DraftField.texts(Self.formFields, b)
        case .payStub(let b, let e):
            { employer = e; return DraftField.texts(Self.stubFields, b) }()
        case .offer(let j, let g):
            { grants = g.map { GrantRow(texts: DraftField.texts(Self.grantFields, $0)) }; return DraftField.texts(Self.jobFields, j) }()
        case .w4(let b, let e):
            { employer = e; return DraftField.texts(Self.w4Fields, b) }()
        case .stateW4(let b, let e):
            { employer = e; return DraftField.texts(Self.stateW4Fields, b) }()
        }
        self.employer = employer
        _texts = State(initialValue: texts)
        _grants = State(initialValue: grants)
    }

    var body: some View {
        if let stub {
            PayStubLinkSheet(stub: stub, header: "Saved. Which deposits are this paycheck? Close to link it later.",
                             onClose: next.map { next in { next(jobId) } })
        } else {
            form
        }
    }

    private var locked: Bool { writes.unresolved || busy }

    private var form: some View {
        Sheet(title: step.map { "\(kind.title) \($0.0) of \($0.1)" } ?? kind.title, canSave: !busy && built, busy: busy, unresolved: writes.unresolved,
              onCancel: { dismiss() },
              onSave: { Task { await save() } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            // at the top, by Save, not below a long form
            if let error { Section { InlineError(message: error) } }
            if let note { Section { Text(note).textStyle(.subhead, color: Palette.secondaryText) } }
            if let updates {
                Section {
                    Text(updates).textStyle(.subhead, color: Palette.secondaryText)
                    // a second form or stub that matched the first is saved beside it
                    if [.taxForm, .payStub].contains(kind) {
                        Button("Save as new") {
                            record = .gone
                            Task { await save() }
                        }
                        .disabled(locked)
                    }
                }
            }
            switch kind {
            case .taxReturn:
                Section { DraftFields(fields: Self.returnFields, texts: $texts, uncertain: uncertain) }.disabled(locked)
            case .taxForm:
                jobSection
                Section { DraftFields(fields: Self.formFields, texts: $texts, uncertain: uncertain) }.disabled(locked)
            case .payStub:
                jobSection
                Section { DraftFields(fields: Self.stubFields, texts: $texts, uncertain: uncertain) }.disabled(locked)
                if let problem = DraftField.build(Self.stubFields, texts, PayStubBody())?.balanceProblem {
                    Section { Text(problem).textStyle(.caption, color: Palette.loss) }
                }
            case .w4:
                jobSection
                Section {
                    DraftFields(fields: Self.w4Fields, texts: $texts, uncertain: uncertain)
                } footer: { Text("Replaces this job's W-4, if it has one.") }
                    .disabled(locked)
            case .stateW4:
                jobSection
                Section {
                    DraftFields(fields: Self.stateW4Fields, texts: $texts, uncertain: uncertain)
                } footer: { Text("Replaces this job's form for that state, if it has one.") }
                    .disabled(locked)
            case .offer:
                Section("Offer") { DraftFields(fields: Self.jobFields, texts: $texts, uncertain: uncertain) }
                    .disabled(locked || savedJobId != nil)
                // an update leaves the job's grants as they are: the read's would be added again
                if !updating { ForEach($grants) { $grant in
                    let i = grants.firstIndex { $0.id == grant.id } ?? 0
                    Section("Grant \(i + 1)") {
                        DraftFields(fields: Self.grantFields, texts: $grant.texts, uncertain: [])
                        if i >= savedGrants {
                            Button("Remove grant", role: .destructive) { grants.removeAll { $0.id == grant.id } }
                        }
                    }
                    .disabled(locked || i < savedGrants)
                } }
                Section {
                    if updating {
                        Text("Updates the saved job. Its grants stay as they are.").textStyle(.caption, color: Palette.secondaryText)
                    } else {
                        if uncertain.contains("grants") { Text("Check the grants against the letter.").textStyle(.caption, color: Palette.loss) }
                        Button("Add grant") { grants.append(GrantRow(texts: ["kind": "rsu"])) }.disabled(locked)
                    }
                }
            }
            if let next { Section { Button("Skip this pay stub") { next(jobId) }.disabled(locked) } }
        }
        .task {
            await loadJobs()
            if kind == .offer { _ = try? await matched() }
        }
        .onChange(of: jobId) { jobPicked = true }
    }

    /// matched a saved record that's still there (or not fetched yet)
    private var updating: Bool { recordId != nil && record?.gone != true }

    /// What a matched draft saves over, so a second form from one payer isn't saved over the first unnoticed.
    private var updates: String? {
        guard updating, let recordId else { return nil }
        switch kind {
        case .taxForm:
            guard let f = record?.form else { return "Updates a saved form." }
            let name = [Self.formKinds.first { $0.value == f.kind }?.label ?? "form", f.year.map(String.init)].compactMap { $0 }.joined(separator: " ")
            return "Updates the saved \(name) from \(f.payer ?? "the same payer")."
        case .payStub: return record?.stub.map { "Updates the saved pay stub for \(DayText.display($0.payDate ?? ""))." } ?? "Updates a saved pay stub."
        case .taxReturn: return "Updates the saved return for this year."
        case .w4: return jobId == recordId ? "Updates this job's saved W-4." : nil
        case .stateW4: return stateUpdate(recordId)
        case .offer: return nil
        }
    }

    private func stateUpdate(_ recordId: String) -> String? {
        let old = recordId.split(separator: ":", maxSplits: 1).map(String.init)
        guard old.count == 2, old[0] == jobId else { return nil }
        if old[1] == texts["state"]?.uppercased() { return "Updates this job's saved \(old[1]) form." }
        return reread ? "Replaces this job's saved \(old[1]) form." : nil
    }

    @ViewBuilder private var jobSection: some View {
        Section {
            Picker("Job", selection: $jobId) {
                Text("None").tag(String?.none)
                ForEach(jobs) { job in Text([job.employer, job.title].compactMap { $0 }.joined(separator: " · ")).tag(Optional(job.id)) }
            }
            .listRowBackground(uncertain.contains("employer") ? Palette.loss.opacity(0.15) : nil)
            .accessibilityHint(uncertain.contains("employer") ? "Not sure the employer was read right; check it against the document" : "")
            if let employer { Text("On the \(kind == .payStub ? "stub" : "form"): \(employer)").textStyle(.caption, color: Palette.secondaryText) }
            if [.w4, .stateW4].contains(kind), jobId == nil { Text("Pick the job this form is for.").textStyle(.caption, color: Palette.secondaryText) }
            if let jobsError {
                InlineError(message: jobsError)
                Button("Try again") { Task { await loadJobs() } }
            }
        }
        .disabled(locked)
    }

    /// Every field parses (the server checks what's required).
    private var built: Bool {
        switch kind {
        case .taxReturn: DraftField.build(Self.returnFields, texts, TaxReturnBody()) != nil
        case .taxForm: DraftField.build(Self.formFields, texts, TaxFormBody()) != nil
        case .payStub: DraftField.build(Self.stubFields, texts, PayStubBody()).map { $0.balanceProblem == nil } ?? false
        case .w4: jobId != nil && DraftField.build(Self.w4Fields, texts, W4Body()) != nil
        case .stateW4: jobId != nil && DraftField.build(Self.stateW4Fields, texts, StateW4Body()) != nil
        case .offer:
            DraftField.build(Self.jobFields, texts, CreateJobBody()) != nil
                && (updating || grants.allSatisfy { DraftField.build(Self.grantFields, $0.texts, GrantBody()) != nil })
        }
    }

    private func loadJobs() async {
        guard [.taxForm, .payStub, .w4, .stateW4].contains(kind), jobs.isEmpty || jobsError != nil, let client = model.client else { return }
        jobsError = nil
        do {
            if jobs.isEmpty { jobs = try await client.jobs() }
            if recordId != nil, [.taxForm, .payStub].contains(kind) {
                // an update keeps the record's job; nothing is suggested unless the record is gone
                let found = try await matched()
                if found.form != nil || found.stub != nil {
                    jobId = found.form?.jobId ?? found.stub?.jobId
                    return
                }
            }
            if jobId == nil { jobId = Job.suggested(for: kind == .taxForm ? texts["payer"] : employer, in: jobs)?.id }
        } catch {
            jobsError = "Couldn't load \(jobs.isEmpty ? "your jobs" : "the saved record"): \(errorMessage(error))"
        }
    }

    private func save() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            guard try await write(client) else { return }
            writes.didSucceed()
            onSaved?()
            if kind == .payStub { return }
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry; it won't be applied twice." : errorMessage(error)
        }
    }

    /// False when a field doesn't parse (Save is off then anyway).
    private func write(_ client: APIClient) async throws -> Bool {
        switch kind {
        case .taxReturn:
            // upserts by year and jurisdiction, so a matched return is updated
            guard let body = DraftField.build(Self.returnFields, texts, TaxReturnBody()) else { return false }
            _ = try await savingDocument(documentId, key: writes.key) { doc, key in
                try await client.putTaxReturn(body, from: nil, documentId: doc, idempotencyKey: key)
            }
        case .taxForm: return try await writeForm(client)
        case .payStub: return try await writeStub(client)
        case .offer: return try await writeOffer(client)
        case .w4, .stateW4: return try await writeWithholding(client)
        }
        return true
    }

    private func matched() async throws -> Record {
        if let record { return record }
        guard let recordId, let client = model.client else { return .gone }
        let found: Record
        do {
            found = switch kind {
            case .taxForm: try await client.taxYears().years.flatMap(\.forms).first { $0.id == recordId }.map(Record.form) ?? .gone
            case .payStub: .stub(try await client.payStub(id: recordId))
            case .offer: .job(try await client.job(id: recordId).job)
            default: .gone
            }
        } catch ClientError.api(status: 404, _) {
            found = .gone
        }
        record = found
        return found
    }

    /// An update patches what the review changes on the record; without the document (gone) and with nothing changed, nothing is sent.
    private func writeForm(_ client: APIClient) async throws -> Bool {
        let match = try await matched().form
        guard var body = DraftField.build(Self.formFields, texts, match?.fields ?? TaxFormBody()) else { return false }
        if match == nil || jobPicked { body.jobId = jobId }
        try await savingDocument(documentId, key: writes.key) { doc, key in
            if let match {
                if doc != nil || body != match.fields {
                    _ = try await client.patchTaxForm(id: match.id, body: body, from: match.fields, documentId: doc, idempotencyKey: key)
                }
            } else {
                _ = try await client.createTaxForm(body, documentId: doc, idempotencyKey: key)
            }
        }
        return true
    }

    private func writeStub(_ client: APIClient) async throws -> Bool {
        let match = try await matched().stub
        guard var body = DraftField.build(Self.stubFields, texts, match?.fields ?? PayStubBody()) else { return false }
        if match == nil || jobPicked { body.jobId = jobId }
        let saved = try await savingDocument(documentId, key: writes.key) { doc, key in
            guard let match else { return try await client.createPayStub(body, documentId: doc, idempotencyKey: key) }
            guard doc != nil || body != match.fields else { return match }
            return try await client.patchPayStub(id: match.id, body: body, from: match.fields, documentId: doc, idempotencyKey: key)
        }
        // on to the deposits it matches, unless an update kept its links
        if match == nil || saved.transactionIds.isEmpty { stub = saved } else if let next { next(jobId) } else { dismiss() }
        return true
    }

    /// A W-4 or state form replaces the job's one (for that state).
    private func writeWithholding(_ client: APIClient) async throws -> Bool {
        guard let jobId else { return false }
        if kind == .w4 {
            guard let body = DraftField.build(Self.w4Fields, texts, W4Body()) else { return false }
            _ = try await savingDocument(documentId, key: writes.key) { doc, key in
                try await client.putW4(jobId: jobId, body: body, documentId: doc, idempotencyKey: key)
            }
        } else {
            guard let body = DraftField.build(Self.stateW4Fields, texts, StateW4Body()) else { return false }
            _ = try await savingDocument(documentId, key: writes.key) { doc, key in
                try await client.putStateW4(jobId: jobId, body: body, documentId: doc, idempotencyKey: key)
            }
            // a re-read whose state code changed is a different form: the old one goes, as on an edit; a fresh read's match may be
            // another real form the reader misread as this one, so it stays
            let old = recordId.flatMap { reread && $0.hasPrefix(jobId + ":") ? String($0.dropFirst(jobId.count + 1)) : nil }
            if let old, old.uppercased() != body.state?.uppercased() {
                try await client.deleteStateW4(jobId: jobId, state: old, idempotencyKey: writes.key + "-old")
            }
        }
        return true
    }

    /// The job first (an update of the matched one keeps its status), then each grant, each its own write; a retry starts at the
    /// first one not saved.
    private func writeOffer(_ client: APIClient) async throws -> Bool {
        if savedJobId == nil {
            let known = record != nil
            let match = try await matched().job
            // the job went during review while its lookup had failed: the read's grants were hidden, so show them first
            if match == nil, !known, recordId != nil, !grants.isEmpty {
                error = "The saved job is gone, so this saves a new one. Check the grants, then save."
                return false
            }
            guard var body = DraftField.build(Self.jobFields, texts, match?.fields ?? CreateJobBody()) else { return false }
            if match == nil { body.status = "offered" }
            savedJobId = try await savingDocument(documentId, key: writes.key) { doc, key in
                guard let match else { return try await client.createJob(body, documentId: doc, idempotencyKey: key).job.id }
                if doc != nil || body != match.fields {
                    _ = try await client.patchJob(id: match.id, body: body, from: match.fields, documentId: doc, idempotencyKey: key)
                }
                return match.id
            }
            writes.didSucceed()
        }
        guard let jobId = savedJobId, record?.job == nil else { return savedJobId != nil }
        while savedGrants < grants.count {
            guard let body = DraftField.build(Self.grantFields, grants[savedGrants].texts, GrantBody()) else { return false }
            _ = try await client.createGrant(jobId: jobId, body: body, idempotencyKey: writes.key)
            writes.didSucceed()
            savedGrants += 1
        }
        return true
    }
}

extension ProfileDraftForm {
    static let filingStatuses: [(value: String, label: String)] = [
        ("single", "Single"), ("married_joint", "Married filing jointly"), ("married_separate", "Married filing separately"),
        ("head_of_household", "Head of household"),
    ]

    static let returnFields: [DraftField<TaxReturnBody>] = [
        .init(key: "year", label: "Tax year", kind: .whole(\.year)),
        .init(key: "jurisdiction", label: "Federal or state code", kind: .code(\.jurisdiction)),
        .init(key: "filingStatus", label: "Filing status", kind: .choice(\.filingStatus, filingStatuses)),
        .init(key: "wagesCents", label: "Wages", kind: .money(\.wagesCents)),
        .init(key: "totalIncomeCents", label: "Total income", kind: .money(\.totalIncomeCents, signed: true)),
        .init(key: "agiCents", label: "Adjusted gross income", kind: .money(\.agiCents, signed: true)),
        .init(key: "deductionKind", label: "Deduction", kind: .choice(\.deductionKind, [("standard", "Standard"), ("itemized", "Itemized")])),
        .init(key: "deductionCents", label: "Deduction amount", kind: .money(\.deductionCents)),
        .init(key: "taxableIncomeCents", label: "Taxable income", kind: .money(\.taxableIncomeCents)),
        .init(key: "totalTaxCents", label: "Total tax", kind: .money(\.totalTaxCents)),
        .init(key: "creditsCents", label: "Credits", kind: .money(\.creditsCents)),
        .init(key: "withholdingCents", label: "Tax withheld", kind: .money(\.withholdingCents)),
        .init(key: "refundCents", label: "Refund (negative when owed)", kind: .money(\.refundCents, signed: true)),
        .init(key: "capitalGainsCents", label: "Capital gains (negative for a loss)", kind: .money(\.capitalGainsCents, signed: true)),
        .init(key: "capitalLossCarryoverCents", label: "Capital loss carryover", kind: .money(\.capitalLossCarryoverCents)),
        .init(key: "capitalLossCarryoverShortCents", label: "Carryover, short-term", kind: .money(\.capitalLossCarryoverShortCents)),
        .init(key: "capitalLossCarryoverLongCents", label: "Carryover, long-term", kind: .money(\.capitalLossCarryoverLongCents)),
        .init(key: "claimedAsDependent", label: "Someone could claim me as a dependent", kind: .flag(\.claimedAsDependent)),
    ]

    static let w4Statuses: [(value: String, label: String)] = [
        ("single", "Single or married filing separately"), ("married_joint", "Married filing jointly"), ("head_of_household", "Head of household"),
    ]

    static let w4Fields: [DraftField<W4Body>] = [
        .init(key: "signedOn", label: "Date signed", kind: .date(\.signedOn)),
        .init(key: "filingStatus", label: "Filing status (step 1c)", kind: .choice(\.filingStatus, w4Statuses)),
        .init(key: "multipleJobs", label: "Multiple jobs (step 2c)", kind: .flag(\.multipleJobs)),
        .init(key: "dependentsCents", label: "Dependents (step 3)", kind: .money(\.dependentsCents)),
        .init(key: "otherIncomeCents", label: "Other income (step 4a)", kind: .money(\.otherIncomeCents)),
        .init(key: "deductionsCents", label: "Deductions (step 4b)", kind: .money(\.deductionsCents)),
        .init(key: "extraWithholdingCents", label: "Extra withholding a paycheck (step 4c)", kind: .money(\.extraWithholdingCents)),
        .init(key: "exempt", label: "Exempt", kind: .flag(\.exempt)),
    ]

    static let stateW4Fields: [DraftField<StateW4Body>] = [
        .init(key: "state", label: "State code", kind: .code(\.state), required: true),
        .init(key: "signedOn", label: "Date signed", kind: .date(\.signedOn)),
        .init(key: "filingStatus", label: "Filing status", kind: .choice(\.filingStatus, [
            ("single", "Single or married filing separately"), ("married", "Married"), ("head_of_household", "Head of household"),
        ])),
        .init(key: "allowances", label: "Allowances", kind: .whole(\.allowances)),
        .init(key: "additionalAllowances", label: "Additional allowances for deductions", kind: .whole(\.additionalAllowances)),
        .init(key: "extraWithholdingCents", label: "Extra withholding a paycheck", kind: .money(\.extraWithholdingCents)),
        .init(key: "exempt", label: "Exempt", kind: .flag(\.exempt)),
    ]

    static let formKinds: [(value: String, label: String)] = [
        ("w2", "W-2"), ("1099_nec", "1099-NEC"), ("1099_int", "1099-INT"), ("1099_div", "1099-DIV"), ("1099_b", "1099-B"), ("1099_misc", "1099-MISC"),
        ("other", "Other"),
    ]

    static let formFields: [DraftField<TaxFormBody>] = [
        .init(key: "kind", label: "Form", kind: .choice(\.kind, formKinds), required: true),
        .init(key: "year", label: "Tax year", kind: .whole(\.year)),
        .init(key: "payer", label: "Employer or payer", kind: .text(\.payer)),
        .init(key: "amountCents", label: "Wages (W-2 box 1) or amount", kind: .money(\.amountCents)),
        .init(key: "federalWithheldCents", label: "Federal tax withheld", kind: .money(\.federalWithheldCents)),
        .init(key: "state", label: "State code", kind: .code(\.state)),
        .init(key: "stateWithheldCents", label: "State tax withheld", kind: .money(\.stateWithheldCents)),
        .init(key: "ssWagesCents", label: "Social Security wages", kind: .money(\.ssWagesCents)),
        .init(key: "medicareWagesCents", label: "Medicare wages", kind: .money(\.medicareWagesCents)),
    ]

    static let stubFields: [DraftField<PayStubBody>] = [
        .init(key: "payDate", label: "Pay date", kind: .date(\.payDate)),
        .init(key: "periodStart", label: "Period start", kind: .date(\.periodStart)),
        .init(key: "periodEnd", label: "Period end", kind: .date(\.periodEnd)),
        .init(key: "grossCents", label: "Gross pay", kind: .money(\.grossCents)),
        .init(key: "federalCents", label: "Federal tax", kind: .money(\.federalCents)),
        .init(key: "stateCents", label: "State tax", kind: .money(\.stateCents)),
        .init(key: "socialSecurityCents", label: "Social Security", kind: .money(\.socialSecurityCents)),
        .init(key: "medicareCents", label: "Medicare", kind: .money(\.medicareCents)),
        .init(key: "retirementCents", label: "Retirement", kind: .money(\.retirementCents)),
        .init(key: "otherDeductionsCents", label: "Other deductions", kind: .money(\.otherDeductionsCents)),
        .init(key: "otherPayCents", label: "Other pay after tax", kind: .money(\.otherPayCents)),
        .init(key: "netCents", label: "Net pay", kind: .money(\.netCents)),
        .init(key: "ytdGrossCents", label: "Gross year to date", kind: .money(\.ytdGrossCents)),
        .init(key: "state", label: "State tax went to (state code)", kind: .code(\.state)),
    ]

    /// a saved stub's job, to give one to a stub saved without
    static func stubJobField(_ jobs: [Job]) -> DraftField<PayStubBody> {
        .init(key: "jobId", label: "Job", kind: .choice(\.jobId, jobs.map { ($0.id, [$0.employer, $0.title].compactMap { $0 }.joined(separator: " · ")) }))
    }

    static let jobFields: [DraftField<CreateJobBody>] = [
        .init(key: "employer", label: "Employer", kind: .text(\.employer)),
        .init(key: "title", label: "Title", kind: .text(\.title)),
        .init(key: "startDate", label: "Start date", kind: .date(\.startDate)),
        .init(key: "endDate", label: "End date", kind: .date(\.endDate)),
        .init(key: "baseCents", label: "Base pay a year", kind: .money(\.baseCents)),
        .init(key: "monthlyCents", label: "Monthly salary", kind: .money(\.monthlyCents)),
        .init(key: "hourlyCents", label: "Hourly rate", kind: .money(\.hourlyCents)),
        .init(key: "hoursPerWeek", label: "Hours per week", kind: .number(\.hoursPerWeek)),
        .init(key: "bonusTargetPct", label: "Bonus target %", kind: .number(\.bonusTargetPct)),
        .init(key: "signingBonusCents", label: "Signing bonus", kind: .money(\.signingBonusCents)),
        .init(key: "relocationCents", label: "Relocation", kind: .money(\.relocationCents)),
        .init(key: "note", label: "Note", kind: .text(\.note)),
    ]

    static let grantFields: [DraftField<GrantBody>] = [
        .init(key: "kind", label: "Kind", kind: .choice(\.kind, [("rsu", "RSU"), ("option", "Option")]), required: true),
        .init(key: "shares", label: "Shares", kind: .number(\.shares)),
        .init(key: "valueCents", label: "Value", kind: .money(\.valueCents)),
        .init(key: "strikeCents", label: "Strike price (options)", kind: .money(\.strikeCents)),
        .init(key: "grantDate", label: "Grant date", kind: .date(\.grantDate)),
        .init(key: "cliffMonths", label: "Cliff (months)", kind: .whole(\.cliffMonths)),
        .init(key: "vestMonths", label: "Vests over (months)", kind: .whole(\.vestMonths)),
        .init(key: "vestEveryMonths", label: "Vests every (months)", kind: .whole(\.vestEveryMonths)),
    ]
}
