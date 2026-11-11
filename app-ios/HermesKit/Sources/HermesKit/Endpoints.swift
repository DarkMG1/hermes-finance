import Foundation

public enum LinkCompletion: Sendable, Equatable {
    case done(Bank)
    case pending
}

extension APIClient {
    public func accounts() async throws -> [Account] { try decode(try await getData("/v1/accounts")) }
    public func categories() async throws -> [Category] { try decode(try await getData("/v1/categories")) }

    public func patchAccount(id: String, body: PatchAccountBody, idempotencyKey: String) async throws -> Account {
        try await write("PATCH", "/v1/accounts/\(id)", body: body, key: idempotencyKey)
    }

    public func putSplits(transactionId: String, body: PutSplitsBody, idempotencyKey: String) async throws -> LedgerTransaction {
        do {
            return try await write("PUT", "/v1/transactions/\(transactionId)/splits", body: body, key: idempotencyKey)
        } catch ClientError.api(400, let error) where body.lines.contains { $0.id != nil } && error.field?.hasPrefix("lines.") == true
            && error.message.contains(#""id""#) {
            // a server before 2.1.1 rejects line ids; without them it keeps IOU links by rank
            let lines = body.lines.map {
                SplitLineBody(amountCents: $0.amountCents, categoryId: $0.categoryId, notes: $0.notes, personId: $0.personId, payee: $0.payee)
            }
            return try await write("PUT", "/v1/transactions/\(transactionId)/splits", body: PutSplitsBody(lines: lines), key: idempotencyKey)
        }
    }

    public func putPayback(transactionId: String, body: PaybackBody, idempotencyKey: String) async throws -> LedgerTransaction {
        try await write("PUT", "/v1/transactions/\(transactionId)/payback", body: body, key: idempotencyKey)
    }

    public func patchSplitLine(transactionId: String, lineId: String, body: PatchSplitLineBody, idempotencyKey: String) async throws -> LedgerTransaction {
        try await write("PATCH", "/v1/transactions/\(transactionId)/lines/\(lineId)", body: body, key: idempotencyKey)
    }

    public func patchTransaction(id: String, body: PatchTransactionBody, idempotencyKey: String) async throws -> LedgerTransaction {
        try await write("PATCH", "/v1/transactions/\(id)", body: body, key: idempotencyKey)
    }

    public func setReconciled(id: String, reconciled: Bool, amountCents: Int?, idempotencyKey: String) async throws -> LedgerTransaction {
        try await write("POST", "/v1/transactions/\(id)/reconcile", body: ReconcileBody(reconciled: reconciled, amountCents: amountCents), key: idempotencyKey)
    }

    public func receipt(transactionId: String) async throws -> Data { try await getData("/v1/transactions/\(transactionId)/receipt") }

    /// Same photo, same result: no idempotency key needed.
    public func putReceipt(transactionId: String, jpeg: Data) async throws {
        try await send("PUT", "/v1/transactions/\(transactionId)/receipt", body: jpeg, contentType: "image/jpeg", idempotencyKey: nil, timeout: 60)
    }

    public func deleteReceipt(transactionId: String) async throws {
        try await send("DELETE", "/v1/transactions/\(transactionId)/receipt", body: nil, idempotencyKey: nil, timeout: 30)
    }

    /// Claude reads the stored photo; reading again replaces the items, so no idempotency key.
    public func readReceipt(transactionId: String) async throws -> Itemization {
        try decode(try await send("POST", "/v1/transactions/\(transactionId)/receipt/read", body: nil, idempotencyKey: nil, timeout: 90).body)
    }

    public func receiptItems(transactionId: String) async throws -> Itemization {
        try decode(try await getData("/v1/transactions/\(transactionId)/receipt/items"))
    }

    public func saveReceiptItems(transactionId: String, body: SaveItemsBody, idempotencyKey: String) async throws -> LedgerTransaction {
        try await write("PUT", "/v1/transactions/\(transactionId)/receipt/items", body: body, key: idempotencyKey)
    }

    public func createTransaction(_ body: CreateTransactionBody, idempotencyKey: String) async throws -> LedgerTransaction {
        try await write("POST", "/v1/transactions", body: body, key: idempotencyKey)
    }

    public func createPerson(_ body: CreatePersonBody, idempotencyKey: String) async throws -> Person {
        try await write("POST", "/v1/people", body: body, key: idempotencyKey)
    }

    public func patchPerson(id: String, body: PatchPersonBody, idempotencyKey: String) async throws -> Person {
        try await write("PATCH", "/v1/people/\(id)", body: body, key: idempotencyKey)
    }

    public func forgive(personId: String, body: ForgiveBody, idempotencyKey: String) async throws -> LedgerTransaction {
        try await write("POST", "/v1/people/\(personId)/forgive", body: body, key: idempotencyKey)
    }

    public func putPeopleSettings(_ body: PeopleSettings, idempotencyKey: String) async throws -> PeopleSettings {
        try await write("PUT", "/v1/people/settings", body: body, key: idempotencyKey)
    }

    /// The deposit is not a repayment: it is never suggested again.
    public func dismissSuggestion(transactionId: String, idempotencyKey: String) async throws {
        try await send("POST", "/v1/people/suggestions/\(transactionId)/dismiss", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    public func deleteTransaction(id: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/transactions/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    public func sync(idempotencyKey: String) async throws -> SyncStatus {
        try decode(try await send("POST", "/v1/sync", body: nil, idempotencyKey: idempotencyKey, timeout: 150).body)
    }

    public func createLinkSession(_ body: LinkSessionBody, idempotencyKey: String) async throws -> LinkSession {
        try await write("POST", "/v1/plaid/link-sessions", body: body, key: idempotencyKey)
    }

    public func completeLinkSession(id: String, idempotencyKey: String) async throws -> LinkCompletion {
        let response = try await send("POST", "/v1/plaid/link-sessions/\(id)/complete", body: nil, idempotencyKey: idempotencyKey, timeout: 150)
        return response.status == 202 ? .pending : .done(try decode(response.body))
    }

    public func importAppleCard(csv: String, idempotencyKey: String) async throws -> AppleCardImportResult {
        try await write("POST", "/v1/imports/apple-card", body: AppleCardImportBody(csv: csv), key: idempotencyKey, timeout: 60)
    }

    public func inbox() async throws -> InboxList { try decode(try await getData("/v1/receipts/inbox")) }

    /// The id comes from the phone, so a retry after a lost reply can't add the receipt twice.
    public func uploadInboxReceipt(id: String, jpeg: Data, capturedAt: Date) async throws {
        try await send("PUT", "/v1/receipts/inbox/\(id)", body: jpeg, contentType: "image/jpeg", idempotencyKey: nil, timeout: 60,
                       extraHeaders: ["x-captured-at": capturedAt.ISO8601Format()])
    }

    public func inboxPhoto(id: String) async throws -> Data { try await getData("/v1/receipts/inbox/\(id)/photo") }

    public func readInboxReceipt(id: String) async throws -> InboxReceipt {
        try decode(try await send("POST", "/v1/receipts/inbox/\(id)/read", body: nil, idempotencyKey: nil, timeout: 90).body)
    }

    public func inboxItems(id: String) async throws -> Itemization { try decode(try await getData("/v1/receipts/inbox/\(id)/items")) }

    public func setInboxFor(id: String, body: InboxForBody, idempotencyKey: String) async throws -> InboxReceipt {
        try await write("PUT", "/v1/receipts/inbox/\(id)/for", body: body, key: idempotencyKey)
    }

    public func saveInboxItems(id: String, body: SaveItemsBody, idempotencyKey: String) async throws -> Itemization {
        try await write("PUT", "/v1/receipts/inbox/\(id)/items", body: body, key: idempotencyKey)
    }

    public func linkInboxReceipt(id: String, transactionId: String, idempotencyKey: String) async throws -> LinkedReceipt {
        try await write("POST", "/v1/receipts/inbox/\(id)/link", body: LinkInboxBody(transactionId: transactionId), key: idempotencyKey)
    }

    public func dismissInboxReceipt(id: String) async throws {
        try await send("POST", "/v1/receipts/inbox/\(id)/dismiss", body: nil, idempotencyKey: nil, timeout: 20)
    }

    public func deleteInboxReceipt(id: String) async throws {
        try await send("DELETE", "/v1/receipts/inbox/\(id)", body: nil, idempotencyKey: nil, timeout: 20)
    }

    public func recurring(includeHidden: Bool = false) async throws -> RecurringList {
        try decode(try await getData("/v1/recurring", query: includeHidden ? [URLQueryItem(name: "hidden", value: "1")] : []))
    }

    public func patchRecurring(id: String, body: PatchRecurringBody, idempotencyKey: String) async throws -> RecurringItem {
        try await write("PATCH", "/v1/recurring/\(id)", body: body, key: idempotencyKey)
    }

    public func createRecurring(body: CreateRecurringBody, idempotencyKey: String) async throws -> RecurringItem {
        try await write("POST", "/v1/recurring", body: body, key: idempotencyKey)
    }

    /// Sets the state outright, so no idempotency key.
    public func putHistoryExclusion(name: String, excludedName: String, excluded: Bool) async throws {
        let body = try JSONEncoder().encode(HistoryExclusionBody(name: name, excludedName: excludedName, excluded: excluded))
        try await send("PUT", "/v1/payee-history/exclusions", body: body, idempotencyKey: nil, timeout: 20)
    }

    /// A 404 means it is already gone.
    public func deleteRecurring(id: String) async throws {
        do { try await send("DELETE", "/v1/recurring/\(id)", body: nil, idempotencyKey: nil, timeout: 20) } catch ClientError.api(status: 404, _) {}
    }

    public func profile() async throws -> Profile { try decode(try await getData("/v1/profile")) }

    /// Whether the server has the financial profile, without loading any of it (it stays behind Face ID); false on an older server.
    public func hasProfile() async throws -> Bool {
        do { _ = try await getData("/v1/profile/exists"); return true } catch ClientError.api(status: 404, _) { return false }
    }

    /// Sends every set field and a null for each one cleared since `original`.
    public func putProfile(_ body: PutProfileBody, from original: PutProfileBody?, idempotencyKey: String) async throws -> Profile {
        try await write("PUT", "/v1/profile", body: edit(body, from: original, keepUnchanged: true), key: idempotencyKey)
    }

    /// Claude reads the pages (JPEGs the phone already blacked out); nothing is stored, so no idempotency key.
    public func readProfileDocument(kind: ProfileKind, pages: [Data]) async throws -> ProfileReadResult {
        let body: [String: JSONValue] = ["kind": .string(kind.rawValue), "pages": .array(pages.map { .string($0.base64EncodedString()) })]
        return try decode(try await send("POST", "/v1/profile/read", body: JSONEncoder().encode(body), idempotencyKey: nil, timeout: 120).body)
    }

    public func jobs() async throws -> [Job] { try decode(try await getData("/v1/jobs")) }
    public func job(id: String) async throws -> JobDetail { try decode(try await getData("/v1/jobs/\(id)")) }

    public func createJob(_ body: CreateJobBody, documentId: String? = nil, idempotencyKey: String) async throws -> JobDetail {
        try await write("POST", "/v1/jobs", body: keeping(body, documentId), key: idempotencyKey)
    }

    // Patches send only what changed from `original` (a cleared field as null); skip the call when nothing did, the server needs a field
    // (a documentId alone counts). Saves take the documentId of the read they came from: the server keeps its pages with the record.
    public func patchJob(id: String, body: CreateJobBody, from original: CreateJobBody,
                         documentId: String? = nil, idempotencyKey: String) async throws -> JobDetail {
        try await write("PATCH", "/v1/jobs/\(id)", body: keeping(edit(body, from: original, keepUnchanged: false), documentId), key: idempotencyKey)
    }

    /// Also deletes its grants; its pay stubs and forms stay, without a job.
    public func deleteJob(id: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/jobs/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    public func createGrant(jobId: String, body: GrantBody, idempotencyKey: String) async throws -> EquityGrant {
        try await write("POST", "/v1/jobs/\(jobId)/grants", body: body, key: idempotencyKey)
    }

    public func patchGrant(jobId: String, id: String, body: GrantBody, from original: GrantBody, idempotencyKey: String) async throws -> EquityGrant {
        try await write("PATCH", "/v1/jobs/\(jobId)/grants/\(id)", body: edit(body, from: original, keepUnchanged: false), key: idempotencyKey)
    }

    public func deleteGrant(jobId: String, id: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/jobs/\(jobId)/grants/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    public func createPayStub(_ body: PayStubBody, documentId: String? = nil, idempotencyKey: String) async throws -> PayStub {
        try await write("POST", "/v1/pay-stubs", body: keeping(body, documentId), key: idempotencyKey)
    }

    /// A new net or pay date that the linked deposits no longer match drops the links.
    public func patchPayStub(id: String, body: PayStubBody, from original: PayStubBody,
                             documentId: String? = nil, idempotencyKey: String) async throws -> PayStub {
        try await write("PATCH", "/v1/pay-stubs/\(id)", body: keeping(edit(body, from: original, keepUnchanged: false), documentId), key: idempotencyKey)
    }

    public func payStub(id: String) async throws -> PayStub { try decode(try await getData("/v1/pay-stubs/\(id)")) }

    /// Pay stubs without a job, newest first.
    public func unassignedPayStubs() async throws -> [PayStub] { try decode(try await getData("/v1/pay-stubs/unassigned")) }

    public func deletePayStub(id: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/pay-stubs/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    public func payStubMatches(id: String) async throws -> PayStubMatches { try decode(try await getData("/v1/pay-stubs/\(id)/matches")) }

    /// The deposits replace any linked before and add up to the net exactly; none unlinks. A deposit another stub has is 409 ALREADY_LINKED.
    public func linkPayStub(id: String, transactionIds: [String], idempotencyKey: String) async throws -> PayStub {
        try await write("PUT", "/v1/pay-stubs/\(id)/link", body: ["transactionIds": transactionIds], key: idempotencyKey)
    }

    /// Replaces the job's W-4: what `body` leaves out is null.
    public func putW4(jobId: String, body: W4Body, documentId: String? = nil, idempotencyKey: String) async throws -> W4Body {
        try await write("PUT", "/v1/jobs/\(jobId)/w4", body: keeping(body, documentId), key: idempotencyKey)
    }

    public func deleteW4(jobId: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/jobs/\(jobId)/w4", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    /// Replaces the job's form for `body.state`: what `body` leaves out is null.
    public func putStateW4(jobId: String, body: StateW4Body, documentId: String? = nil, idempotencyKey: String) async throws -> StateW4Body {
        var fields = try keeping(body, documentId)
        fields.removeValue(forKey: "state")
        return try await write("PUT", "/v1/jobs/\(jobId)/state-w4/\(body.state ?? "")", body: fields, key: idempotencyKey)
    }

    /// Already gone (deleted on another device) is done, so a save that replaces the form can finish.
    public func deleteStateW4(jobId: String, state: String, idempotencyKey: String) async throws {
        do {
            try await send("DELETE", "/v1/jobs/\(jobId)/state-w4/\(state)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
        } catch ClientError.api(status: 404, _) {}
    }

    public func createTaxForm(_ body: TaxFormBody, documentId: String? = nil, idempotencyKey: String) async throws -> TaxForm {
        try await write("POST", "/v1/tax-forms", body: keeping(body, documentId), key: idempotencyKey)
    }

    public func patchTaxForm(id: String, body: TaxFormBody, from original: TaxFormBody,
                             documentId: String? = nil, idempotencyKey: String) async throws -> TaxForm {
        try await write("PATCH", "/v1/tax-forms/\(id)", body: keeping(edit(body, from: original, keepUnchanged: false), documentId), key: idempotencyKey)
    }

    public func deleteTaxForm(id: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/tax-forms/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    public func taxYears() async throws -> TaxYears { try decode(try await getData("/v1/tax-years")) }

    /// Upserts by year + jurisdiction: left-out fields keep the saved return's values, so pass the return being edited as `original`
    /// to clear what the owner cleared. Without one (a document read) every blank field goes out as null: the return becomes what was reviewed.
    public func putTaxReturn(_ body: TaxReturnBody, from original: TaxReturnBody?,
                             documentId: String? = nil, idempotencyKey: String) async throws -> TaxReturn {
        try await write("PUT", "/v1/tax-returns", body: keeping(edit(body, from: original, keepUnchanged: true), documentId), key: idempotencyKey)
    }

    public func deleteTaxReturn(id: String, idempotencyKey: String) async throws {
        try await send("DELETE", "/v1/tax-returns/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30)
    }

    /// Newest first; only those linked to `record` when given. An older server keeps none.
    public func documents(linkedTo record: DocumentLink? = nil) async throws -> [KeptDocument] {
        let query = record.map { [URLQueryItem(name: "recordType", value: $0.recordType.rawValue), URLQueryItem(name: "recordId", value: $0.recordId)] } ?? []
        do {
            let list: [String: [KeptDocument]] = try decode(try await getData("/v1/documents", query: query))
            return list["documents"] ?? []
        } catch ClientError.api(status: 404, _) { return [] }
    }

    public func document(id: String) async throws -> KeptDocument { try decode(try await getData("/v1/documents/\(id)")) }

    /// A JPEG; `page` from 1 to the document's pageCount.
    public func documentPage(id: String, page: Int) async throws -> Data { try await getData("/v1/documents/\(id)/pages/\(page)") }

    /// The pages go; the records saved from them stay.
    public func deleteDocument(id: String, idempotencyKey: String) async throws {
        do { try await send("DELETE", "/v1/documents/\(id)", body: nil, idempotencyKey: idempotencyKey, timeout: 30) } catch ClientError.api(status: 404, _) {}
    }

    /// Claude reads the kept pages again; each draft's recordId is the linked record to update. Keeps no new copy, so no idempotency key.
    public func rereadDocument(id: String) async throws -> ProfileReadResult {
        try decode(try await send("POST", "/v1/documents/\(id)/read", body: nil, idempotencyKey: nil, timeout: 120).body)
    }
}
