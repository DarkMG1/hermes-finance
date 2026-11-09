import Foundation

// Bodies double as read drafts and as the editable part of saved rows, so every field is optional: a draft may miss any of them,
// and the server answers 400 with the field when a required one is missing. Enum-valued fields are the server's raw strings.

/// About me. Also the GET /v1/profile reply.
public struct PutProfileBody: Codable, Sendable, Equatable {
    public var state: String?
    public var filingStatus: String?
    public var birthYear: Int?
    public var dependents: Int?
    public var retirementPct: Double?
    public var retirementKind: String?
    /// has a health savings account
    public var hsa: Bool?
    public var note: String?
    public init() {}
}

public typealias Profile = PutProfileBody

public struct CreateJobBody: Codable, Sendable, Equatable {
    public var employer: String?
    public var title: String?
    /// offered, accepted, declined, current or past
    public var status: String?
    public var startDate: String?
    public var endDate: String?
    /// annual base pay
    public var baseCents: Int?
    public var hourlyCents: Int?
    public var hoursPerWeek: Double?
    public var bonusTargetPct: Double?
    public var signingBonusCents: Int?
    public var relocationCents: Int?
    public var note: String?
    public init() {}
}

public struct GrantBody: Codable, Sendable, Equatable {
    /// rsu or option
    public var kind: String?
    public var shares: Double?
    public var valueCents: Int?
    /// options only: the price per share
    public var strikeCents: Int?
    public var grantDate: String?
    public var cliffMonths: Int?
    public var vestMonths: Int?
    public var vestEveryMonths: Int?
    public init() {}
}

/// Left-out deduction lines and other pay are 0; gross minus every line plus other pay must equal net within a cent.
public struct PayStubBody: Codable, Sendable, Equatable {
    public var jobId: String?
    public var payDate: String?
    public var periodStart: String?
    public var periodEnd: String?
    public var grossCents: Int?
    public var federalCents: Int?
    public var stateCents: Int?
    public var socialSecurityCents: Int?
    public var medicareCents: Int?
    public var retirementCents: Int?
    public var otherDeductionsCents: Int?
    /// after-tax additions (reimbursements, stipends)
    public var otherPayCents: Int?
    public var netCents: Int?
    public var ytdGrossCents: Int?
    public init() {}

    /// What net would need to change by for the stub to balance (the server allows a cent either way); nil until gross and net are set.
    public var imbalanceCents: Int? {
        guard let grossCents, let netCents else { return nil }
        let deductions = [federalCents, stateCents, socialSecurityCents, medicareCents, retirementCents, otherDeductionsCents].reduce(0) { $0 + ($1 ?? 0) }
        return grossCents - deductions + (otherPayCents ?? 0) - netCents
    }

    /// Why Save stays off: the lines don't add up to net, or year to date is less than this period.
    public var balanceProblem: String? {
        if let off = imbalanceCents, let net = netCents, abs(off) > 1 {
            return "Off by \(Money.format(abs(off))): gross minus deductions plus other pay is \(Money.format(net + off)), net is \(Money.format(net))"
        }
        if let ytd = ytdGrossCents, let gross = grossCents, ytd < gross { return "Gross year to date is less than gross pay" }
        return nil
    }
}

public struct TaxFormBody: Codable, Sendable, Equatable {
    public var jobId: String?
    public var year: Int?
    /// w2, 1099_nec, 1099_int, 1099_div, 1099_b, 1099_misc or other
    public var kind: String?
    public var payer: String?
    /// wages (W-2 box 1), box 1, or the form's total
    public var amountCents: Int?
    public var federalWithheldCents: Int?
    public var state: String?
    public var stateWithheldCents: Int?
    public var ssWagesCents: Int?
    public var medicareWagesCents: Int?
    public init() {}
}

/// Upserts by year + jurisdiction ("federal" or a 2-letter state code).
public struct TaxReturnBody: Codable, Sendable, Equatable {
    public var year: Int?
    public var jurisdiction: String?
    public var filingStatus: String?
    public var wagesCents: Int?
    public var totalIncomeCents: Int?
    public var agiCents: Int?
    /// standard or itemized
    public var deductionKind: String?
    public var deductionCents: Int?
    public var taxableIncomeCents: Int?
    public var totalTaxCents: Int?
    public var creditsCents: Int?
    public var withholdingCents: Int?
    /// positive refund, negative owed
    public var refundCents: Int?
    public var capitalGainsCents: Int?
    public var capitalLossCarryoverCents: Int?
    public init() {}
}

/// A saved row: its id around the fields the owner edits; `fields` is what an edit form starts from and diffs against.
@dynamicMemberLookup
public struct Saved<Fields: Codable & Sendable & Equatable>: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// pay stubs only: the linked deposits (a paycheck split across accounts has several)
    public let transactionIds: [String]
    public let fields: Fields

    private enum Keys: String, CodingKey { case id, transactionIds }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        transactionIds = try c.decodeIfPresent([String].self, forKey: .transactionIds) ?? []
        fields = try Fields(from: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        try fields.encode(to: encoder)
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id)
        try c.encode(transactionIds, forKey: .transactionIds)
    }

    public subscript<T>(dynamicMember path: KeyPath<Fields, T>) -> T { fields[keyPath: path] }
}

public typealias Job = Saved<CreateJobBody>
public typealias EquityGrant = Saved<GrantBody>
public typealias PayStub = Saved<PayStubBody>
public typealias TaxForm = Saved<TaxFormBody>
public typealias TaxReturn = Saved<TaxReturnBody>

public struct VestEvent: Codable, Sendable, Hashable {
    public let date: String
    public let shares: Double?
    public let valueCents: Int?
    public let grantId: String
}

@dynamicMemberLookup
public struct JobDetail: Codable, Sendable, Equatable {
    public let job: Job
    public let grants: [EquityGrant]
    /// the next few vest dates across the job's grants
    public let nextVests: [VestEvent]
    /// newest first
    public let stubs: [PayStub]
    public let forms: [TaxForm]

    private enum Keys: String, CodingKey { case grants, nextVests, stubs, forms }

    public init(from decoder: Decoder) throws {
        job = try Job(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        grants = try c.decode([EquityGrant].self, forKey: .grants)
        nextVests = try c.decode([VestEvent].self, forKey: .nextVests)
        stubs = try c.decode([PayStub].self, forKey: .stubs)
        forms = try c.decode([TaxForm].self, forKey: .forms)
    }

    public func encode(to encoder: Encoder) throws {
        try job.encode(to: encoder)
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(grants, forKey: .grants)
        try c.encode(nextVests, forKey: .nextVests)
        try c.encode(stubs, forKey: .stubs)
        try c.encode(forms, forKey: .forms)
    }

    public subscript<T>(dynamicMember path: KeyPath<CreateJobBody, T>) -> T { job.fields[keyPath: path] }
}

public struct TaxYears: Codable, Sendable, Equatable {
    public struct Year: Codable, Sendable, Equatable {
        public let year: Int
        public let returns: [TaxReturn]
        public let forms: [TaxForm]
        /// the federal return's total tax / total income; nil without one
        public let effectiveRate: Double?
    }
    public let years: [Year]
}

/// The pay stub linked to a deposit: only its id, its figures are read behind Face ID.
public struct PayStubSummary: Codable, Sendable, Hashable {
    public let id: String
}

/// Deposits a pay stub can link: bank deposits within 3 days of its pay date, at most its net, closest first; `suggestions` are single
/// deposits and pairs that add up to the net, as ids into `deposits`.
public struct PayStubMatches: Codable, Sendable {
    public let deposits: [LedgerTransaction]
    public let suggestions: [[String]]
}

public enum ProfileKind: String, Codable, Sendable, CaseIterable {
    case taxReturn = "tax_return", taxForm = "tax_form", payStub = "pay_stub", offer
}

/// What Claude read off a document for the owner to review; nothing is stored until it is saved. A pay stub's job and a form's
/// job are left for the owner to pick (the stub's employer helps); an offer has no status.
public enum ProfileDraft: Sendable, Equatable {
    case taxReturn(TaxReturnBody)
    case taxForm(TaxFormBody)
    case payStub(PayStubBody, employer: String?)
    case offer(CreateJobBody, grants: [GrantBody])
}

public struct ProfileReadResult: Decodable, Sendable, Equatable {
    public let kind: ProfileKind
    public let draft: ProfileDraft
    /// field names Claude is unsure of
    public let uncertain: [String]
    /// Each document read, in page order: a PDF can hold a run of pay stubs. Just this one for any other kind, or from a server before 2.2.1.
    private let documents: [ProfileReadResult]

    private enum Keys: String, CodingKey { case kind, draft, uncertain, stubs }
    private enum DraftKeys: String, CodingKey { case employer, grants }

    private init(kind: ProfileKind, draft: ProfileDraft, uncertain: [String]) {
        self.kind = kind
        self.draft = draft
        self.uncertain = uncertain
        documents = []
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        kind = try c.decode(ProfileKind.self, forKey: .kind)
        (draft, uncertain) = try Self.read(c, kind)
        if kind == .payStub, var stubs = try? c.nestedUnkeyedContainer(forKey: .stubs) {
            var all: [ProfileReadResult] = []
            while !stubs.isAtEnd {
                let one = try stubs.nestedContainer(keyedBy: Keys.self)
                let (draft, uncertain) = try Self.read(one, kind)
                all.append(ProfileReadResult(kind: kind, draft: draft, uncertain: uncertain))
            }
            documents = all
        } else {
            documents = []
        }
    }

    /// The draft and uncertain fields in `c`.
    private static func read(_ c: KeyedDecodingContainer<Keys>, _ kind: ProfileKind) throws -> (ProfileDraft, [String]) {
        let uncertain = try c.decodeIfPresent([String].self, forKey: .uncertain) ?? []
        let extra = try c.nestedContainer(keyedBy: DraftKeys.self, forKey: .draft)
        let draft: ProfileDraft = switch kind {
        case .taxReturn: .taxReturn(try c.decode(TaxReturnBody.self, forKey: .draft))
        case .taxForm: .taxForm(try c.decode(TaxFormBody.self, forKey: .draft))
        case .payStub: .payStub(try c.decode(PayStubBody.self, forKey: .draft), employer: try extra.decodeIfPresent(String.self, forKey: .employer))
        case .offer: .offer(try c.decode(CreateJobBody.self, forKey: .draft), grants: try extra.decodeIfPresent([GrantBody].self, forKey: .grants) ?? [])
        }
        return (draft, uncertain)
    }

    /// Every document to review: the stubs when there are several, else this one.
    public var reads: [ProfileReadResult] { documents.isEmpty ? [self] : documents }
}

/// An edit as JSON: fields the owner cleared go out as null; `keepUnchanged: false` leaves out what still matches `original`.
/// With no `original` and `keepUnchanged`, every empty field goes out as null, so a merge on the server keeps nothing the body left blank.
func edit<B: Encodable>(_ body: B, from original: B?, keepUnchanged: Bool) throws -> [String: JSONValue] {
    func object(_ b: B) throws -> [String: JSONValue] { try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(b)) }
    let new = try object(body), old = try original.map(object) ?? [:]
    var out = keepUnchanged ? new : new.filter { old[$0.key] != $0.value }
    for key in old.keys where new[key] == nil { out[key] = .null }
    if original == nil, keepUnchanged {
        for case let key? in Mirror(reflecting: body).children.map(\.label) where out[key] == nil { out[key] = .null }
    }
    return out
}
