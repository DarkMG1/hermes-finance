import Foundation
import HermesKit
import Observation

@Observable
@MainActor
final class BankLinker {
    var busy = false
    var error: String?
    var note: String?

    func add(model: AppModel, authenticate: (URL) async throws -> URL) async {
        await run(.create, model: model, authenticate: authenticate)
    }

    func reconnect(itemId: String, model: AppModel, authenticate: (URL) async throws -> URL) async {
        await run(.update(itemId: itemId), model: model, authenticate: authenticate)
    }

    private func run(_ body: LinkSessionBody, model: AppModel, authenticate: (URL) async throws -> URL) async {
        guard let client = model.client else { return }
        busy = true
        error = nil
        note = nil
        defer { busy = false }
        do {
            let session = try await client.createLinkSession(body, idempotencyKey: UUID().uuidString)
            guard let url = URL(string: session.url) else { throw ClientError.decoding("bad link address") }
            // Closing the sheet early is not proof of cancelling: the bank may already be linked, so always ask the server.
            _ = try? await authenticate(url)
            switch try await finishLink(client: client, sessionId: session.sessionId, key: UUID().uuidString) {
            case .linked(let bank): note = "\(bank.institutionName) is connected."
            case .cancelled: note = "Bank linking was cancelled."
            case .stillPending: note = "Still finishing with your bank. Check back in a minute."
            }
            await model.refreshReferenceData()
        } catch {
            self.error = errorMessage(error)
        }
    }
}
