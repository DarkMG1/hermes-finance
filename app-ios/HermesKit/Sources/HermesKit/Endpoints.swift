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
        try await write("PUT", "/v1/transactions/\(transactionId)/splits", body: body, key: idempotencyKey)
    }

    public func patchTransaction(id: String, body: PatchTransactionBody, idempotencyKey: String) async throws -> LedgerTransaction {
        try await write("PATCH", "/v1/transactions/\(id)", body: body, key: idempotencyKey)
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
}
