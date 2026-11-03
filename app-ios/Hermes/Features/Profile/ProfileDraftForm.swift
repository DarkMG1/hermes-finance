import HermesKit
import SwiftUI

/// One input on a review form, read from and written into its body by key path. `key` is the body's JSON name, as `uncertain` lists it.
struct DraftField<B> {
    enum Kind {
        case money(WritableKeyPath<B, Int?>, signed: Bool = false)
        case whole(WritableKeyPath<B, Int?>)
        case number(WritableKeyPath<B, Double?>)
        case date(WritableKeyPath<B, String?>)
        case text(WritableKeyPath<B, String?>)
        /// "federal" or a state code
        case code(WritableKeyPath<B, String?>)
        case choice(WritableKeyPath<B, String?>, [(value: String, label: String)])
        case flag(WritableKeyPath<B, Bool?>)
    }

    let key: String
    let label: String
    let kind: Kind
    /// a choice the server needs: no "None"
    var required = false

    func text(_ body: B) -> String {
        switch kind {
        case .money(let p, _): FieldText.cents(body[keyPath: p])
        case .whole(let p): body[keyPath: p].map(String.init) ?? ""
        case .number(let p): FieldText.number(body[keyPath: p])
        case .date(let p), .text(let p), .code(let p), .choice(let p, _): body[keyPath: p] ?? ""
        case .flag(let p): body[keyPath: p].map { $0 ? "yes" : "no" } ?? ""
        }
    }

    /// Writes what the text means into `body` (empty is nil); false when it doesn't parse.
    func apply(_ text: String, to body: inout B) -> Bool {
        func put<T>(_ p: WritableKeyPath<B, T?>, _ parse: (String) -> T?) -> Bool {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            // a required choice left blank keeps Save off
            guard !t.isEmpty else { body[keyPath: p] = nil; return !required }
            guard let v = parse(t) else { return false }
            body[keyPath: p] = v
            return true
        }
        switch kind {
        case .money(let p, let signed): return put(p) { FieldText.cents($0, signed: signed) }
        case .whole(let p): return put(p, FieldText.whole)
        case .number(let p): return put(p, FieldText.number)
        case .date(let p): return put(p, FieldText.date)
        case .text(let p), .choice(let p, _): return put(p) { $0 }
        case .code(let p): return put(p, FieldText.code)
        case .flag(let p): return put(p) { $0 == "yes" }
        }
    }

    /// Empty text counts: the server says which fields it needs.
    func parses(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return true }
        return switch kind {
        case .money(_, let signed): FieldText.cents(t, signed: signed) != nil
        case .whole: FieldText.whole(t) != nil
        case .number: FieldText.number(t) != nil
        case .date: FieldText.date(t) != nil
        case .text, .code, .choice, .flag: true
        }
    }

    var hint: String {
        switch kind {
        case .money: "Enter an amount like 1,234.56"
        case .whole: "Enter a whole number"
        case .number: "Enter a number"
        case .date: "Enter a date like 2026-01-31"
        case .text, .code, .choice, .flag: ""
        }
    }

    var options: [(value: String, label: String)]? {
        switch kind {
        case .choice(_, let options): options
        case .flag: [("yes", "Yes"), ("no", "No")]
        default: nil
        }
    }

    static func texts(_ fields: [DraftField], _ body: B) -> [String: String] {
        Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0.text(body)) })
    }

    /// `base` with every field's text, or nil when one doesn't parse.
    static func build(_ fields: [DraftField], _ texts: [String: String], _ base: B) -> B? {
        var body = base
        return fields.allSatisfy { $0.apply(texts[$0.key] ?? "", to: &body) } ? body : nil
    }
}

struct DraftFields<B>: View {
    let fields: [DraftField<B>]
    @Binding var texts: [String: String]
    let uncertain: Set<String>

    var body: some View {
        ForEach(fields, id: \.key) { field in
            let text = Binding { texts[field.key] ?? "" } set: { texts[field.key] = $0 }
            Group {
                if let options = field.options {
                    Picker(field.label, selection: text) {
                        if !field.required || text.wrappedValue.isEmpty { Text(field.required ? "Choose" : "None").tag("") }
                        ForEach(options, id: \.value) { Text($0.label).tag($0.value) }
                    }
                } else {
                    Field(label: field.label, error: field.parses(text.wrappedValue) ? nil : field.hint) {
                        TextField(field.label, text: text)
                            .keyboardType(Self.keyboard(field.kind))
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(Self.isCode(field.kind) ? .characters : .sentences)
                    }
                }
            }
            // what Claude wasn't sure of stands out until checked
            .listRowBackground(uncertain.contains(field.key) ? Palette.loss.opacity(0.15) : nil)
            .accessibilityHint(uncertain.contains(field.key) ? "Not sure this was read right; check it against the document" : "")
        }
    }

    private static func isCode(_ kind: DraftField<B>.Kind) -> Bool { if case .code = kind { true } else { false } }

    private static func keyboard(_ kind: DraftField<B>.Kind) -> UIKeyboardType {
        switch kind {
        case .money(_, let signed): signed ? .numbersAndPunctuation : .decimalPad
        case .whole: .numberPad
        case .number: .decimalPad
        case .date: .numbersAndPunctuation
        case .text, .code, .choice, .flag: .default
        }
    }
}

/// Review what was read (or enter it by hand), then save it. A pay stub then offers the deposits it matches; an offer saves its job
/// (status offered) and then each grant.
struct ProfileDraftForm: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let kind: ProfileKind
    let uncertain: Set<String>
    /// the employer printed on a pay stub
    private let employer: String?

    private struct GrantRow: Identifiable {
        let id = UUID()
        var texts: [String: String]
    }

    @State private var texts: [String: String]
    @State private var grants: [GrantRow]
    @State private var jobs: [Job] = []
    @State private var jobsError: String?
    @State private var jobId: String?
    @State private var writes = WriteGuard()
    @State private var busy = false
    @State private var error: String?
    /// an offer's job and grants already saved, so a retry carries on from the next one
    @State private var savedJobId: String?
    @State private var savedGrants = 0
    @State private var stub: PayStub?

    init(kind: ProfileKind, draft: ProfileDraft, uncertain: Set<String>) {
        self.kind = kind
        self.uncertain = uncertain
        var employer: String?
        var grants: [GrantRow] = []
        let texts: [String: String] = switch draft {
        case .taxReturn(let b): DraftField.texts(Self.returnFields, b)
        case .taxForm(let b): DraftField.texts(Self.formFields, b)
        case .payStub(let b, let e):
            { employer = e; return DraftField.texts(Self.stubFields, b) }()
        case .offer(let j, let g):
            { grants = g.map { GrantRow(texts: DraftField.texts(Self.grantFields, $0)) }; return DraftField.texts(Self.jobFields, j) }()
        }
        self.employer = employer
        _texts = State(initialValue: texts)
        _grants = State(initialValue: grants)
    }

    var body: some View {
        if let stub { PayStubLinkSheet(stub: stub, header: "Saved. Which deposits are this paycheck? Close to link it later.") } else { form }
    }

    private var locked: Bool { writes.unresolved || busy }

    private var form: some View {
        Sheet(title: kind.title, canSave: !busy && built, busy: busy, unresolved: writes.unresolved, onCancel: { dismiss() },
              onSave: { Task { await save() } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
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
            case .offer:
                Section("Offer") { DraftFields(fields: Self.jobFields, texts: $texts, uncertain: uncertain) }
                    .disabled(locked || savedJobId != nil)
                ForEach($grants) { $grant in
                    let i = grants.firstIndex { $0.id == grant.id } ?? 0
                    Section("Grant \(i + 1)") {
                        DraftFields(fields: Self.grantFields, texts: $grant.texts, uncertain: [])
                        if i >= savedGrants {
                            Button("Remove grant", role: .destructive) { grants.removeAll { $0.id == grant.id } }
                        }
                    }
                    .disabled(locked || i < savedGrants)
                }
                Section {
                    if uncertain.contains("grants") { Text("Check the grants against the letter.").textStyle(.caption, color: Palette.loss) }
                    Button("Add grant") { grants.append(GrantRow(texts: ["kind": "rsu"])) }.disabled(locked)
                }
            }
            if let error { Section { InlineError(message: error) } }
        }
        .task { await loadJobs() }
    }

    @ViewBuilder private var jobSection: some View {
        Section {
            Picker("Job", selection: $jobId) {
                Text("None").tag(String?.none)
                ForEach(jobs) { job in Text([job.employer, job.title].compactMap { $0 }.joined(separator: " · ")).tag(Optional(job.id)) }
            }
            .listRowBackground(uncertain.contains("employer") ? Palette.loss.opacity(0.15) : nil)
            .accessibilityHint(uncertain.contains("employer") ? "Not sure the employer was read right; check it against the document" : "")
            if let employer { Text("On the stub: \(employer)").textStyle(.caption, color: Palette.secondaryText) }
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
        case .offer:
            DraftField.build(Self.jobFields, texts, CreateJobBody()) != nil
                && grants.allSatisfy { DraftField.build(Self.grantFields, $0.texts, GrantBody()) != nil }
        }
    }

    private func loadJobs() async {
        guard kind == .taxForm || kind == .payStub, jobs.isEmpty, let client = model.client else { return }
        jobsError = nil
        do {
            jobs = try await client.jobs()
            if jobId == nil { jobId = Job.suggested(for: kind == .payStub ? employer : texts["payer"], in: jobs)?.id }
        } catch {
            jobsError = "Couldn't load your jobs: \(errorMessage(error))"
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
            guard let body = DraftField.build(Self.returnFields, texts, TaxReturnBody()) else { return false }
            _ = try await client.putTaxReturn(body, from: nil, idempotencyKey: writes.key)
        case .taxForm:
            guard var body = DraftField.build(Self.formFields, texts, TaxFormBody()) else { return false }
            body.jobId = jobId
            _ = try await client.createTaxForm(body, idempotencyKey: writes.key)
        case .payStub:
            guard var body = DraftField.build(Self.stubFields, texts, PayStubBody()) else { return false }
            body.jobId = jobId
            // on to the deposits it matches
            stub = try await client.createPayStub(body, idempotencyKey: writes.key)
        case .offer: return try await writeOffer(client)
        }
        return true
    }

    /// The job first, then each grant, each its own write; a retry starts at the first one not saved.
    private func writeOffer(_ client: APIClient) async throws -> Bool {
        if savedJobId == nil {
            guard var body = DraftField.build(Self.jobFields, texts, CreateJobBody()) else { return false }
            body.status = "offered"
            savedJobId = try await client.createJob(body, idempotencyKey: writes.key).job.id
            writes.didSucceed()
        }
        guard let jobId = savedJobId else { return false }
        while savedGrants < grants.count {
            guard let body = DraftField.build(Self.grantFields, grants[savedGrants].texts, GrantBody()) else { return false }
            _ = try await client.createGrant(jobId: jobId, body: body, idempotencyKey: writes.key)
            writes.didSucceed()
            savedGrants += 1
        }
        return true
    }

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

/// The deposits a saved pay stub can link: one, or several that add up to its net (a paycheck split across accounts); linking closes it.
struct PayStubLinkSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let stub: PayStub
    var header = "Which deposits are this paycheck?"
    @State private var matches: PayStubMatches?
    @State private var matchesError: String?
    @State private var selected: Set<String> = []
    @State private var writes = WriteGuard()
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let net = stub.netCents ?? 0
        let total = matches?.deposits.filter { selected.contains($0.id) }.reduce(0) { $0 + $1.amountCents } ?? 0
        Sheet(title: "Link deposit", saveTitle: "Link", canSave: !busy && !selected.isEmpty && total == net, busy: busy, unresolved: writes.unresolved,
              dirty: false, onCancel: { dismiss() }, onSave: { Task { await link() } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                if let matches {
                    if matches.deposits.isEmpty {
                        Text("No deposit within 3 days of the pay date yet. You can link it later.").textStyle(.subhead, color: Palette.secondaryText)
                    }
                    ForEach(matches.deposits) { t in
                        Button {
                            if selected.contains(t.id) { selected.remove(t.id) } else { selected.insert(t.id) }
                        } label: {
                            HStack {
                                Image(systemName: selected.contains(t.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(Palette.accent)
                                TransactionRow(transaction: t)
                            }
                        }
                        .buttonStyle(.plain)
                        // after an unconfirmed link only the same deposits may be retried
                        .disabled(busy || writes.unresolved)
                        .accessibilityAddTraits(selected.contains(t.id) ? .isSelected : [])
                    }
                } else if let matchesError {
                    InlineError(message: matchesError)
                    Button("Try again") { Task { await loadMatches() } }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } header: { Text(header) } footer: {
                if matches?.deposits.isEmpty == false {
                    Text("Selected \(Money.format(total)) of \(Money.format(net)) net")
                        .textStyle(.caption, color: total == net ? Palette.secondaryText : Palette.loss)
                }
            }
            if let error { Section { InlineError(message: error) } }
        }
        .task { await loadMatches() }
    }

    private func loadMatches() async {
        guard matches == nil, let client = model.client else { return }
        matchesError = nil
        do {
            let m = try await client.payStubMatches(id: stub.id)
            matches = m
            selected = Set(stub.transactionIds.isEmpty ? m.suggestions.first ?? [] : stub.transactionIds)
        } catch {
            matchesError = errorMessage(error)
        }
    }

    private func link() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            let ids = matches?.deposits.map(\.id).filter(selected.contains) ?? []
            _ = try await client.linkPayStub(id: stub.id, transactionIds: ids, idempotencyKey: writes.key)
            writes.didSucceed()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the link. Tap Link to retry; it won't be applied twice." : errorMessage(error)
        }
    }
}
