import Foundation
import UIKit
import HermesKit
// swiftlint:disable:next duplicate_imports
import struct HermesKit.Category
import Observation

enum ConnectError: LocalizedError {
    case badURL
    var errorDescription: String? { "Enter the server address, starting with https://" }
}

@Observable
@MainActor
final class AppModel {
    private(set) var client: APIClient?
    private(set) var reader: Reader?
    var categories: [Category] = []
    var accounts: [Account] = []
    var people: [Person] = []
    let receiptQueue = ReceiptQueue()

    private let keychain = KeychainStore(service: "dev.darkmg1.hermesfinance")
    private let cache: ResponseCache
    // bumped on disconnect/reconnect so reads still in flight from the old connection are discarded
    private var session = 0
    private let referenceRefresh = ReferenceDataRefresh()

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        cache = ResponseCache(directory: caches.appending(path: "api-cache"))
        URLCache.shared.removeAllCachedResponses()
        loadStoredConnection()
    }

    // The keychain token and UserDefaults can't be read while the phone is locked (a prewarmed launch), so this
    // no-ops until protected data is available and is retried when the app becomes active.
    func loadStoredConnection() {
        guard reader == nil, UIApplication.shared.isProtectedDataAvailable else { return }
        // files written before this release lack the stronger protection class
        if !UserDefaults.standard.bool(forKey: "cacheProtectedV2") {
            cache.clear()
            UserDefaults.standard.set(true, forKey: "cacheProtectedV2")
        }
        guard let url = URL(string: serverURL), !serverURL.isEmpty else {
            keychain.delete("apiToken")
            return
        }
        guard let token = keychain.read("apiToken") else { return }
        try? keychain.write("apiToken", token)
        configure(url: url, token: token, migratingReceipts: true)
    }

    var serverURL: String { UserDefaults.standard.string(forKey: "serverURL") ?? "" }

    func connect(urlText: String, token: String) async throws {
        guard let url = URL(string: urlText.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host() != nil else {
            throw ConnectError.badURL
        }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await APIClient(baseURL: url, token: trimmedToken, transport: URLSessionTransport()).accounts()
        try keychain.write("apiToken", trimmedToken)
        // Unscoped photos without a saved origin must never be adopted by a newly entered server.
        UserDefaults.standard.set(true, forKey: "receiptQueueScoped")
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        configure(url: url, token: trimmedToken)
        await refreshReferenceData()
    }

    func disconnect() {
        session += 1
        referenceRefresh.invalidate()
        receiptQueue.selectServer(nil)
        UserDefaults.standard.set(true, forKey: "receiptQueueScoped")
        URLCache.shared.removeAllCachedResponses()
        keychain.delete("apiToken")
        UserDefaults.standard.removeObject(forKey: "serverURL")
        cache.clear()
        client = nil
        reader = nil
        categories = []
        accounts = []
        people = []
    }

    func refreshReferenceData(coalescing: Bool = false) async {
        guard let reader else { return }
        let current = session
        guard let loaded = await referenceRefresh.request(using: reader, coalescing: coalescing).value,
              referenceRefresh.isCurrent(loaded), current == session, !Task.isCancelled else { return }
        if let categories = loaded.categories { self.categories = categories }
        if let accounts = loaded.accounts { self.accounts = accounts }
        if let people = loaded.people { self.people = people }
    }

    func categoryName(_ id: String?) -> String {
        guard let id else { return "Uncategorized" }
        return categories.first { $0.id == id }?.name ?? "Uncategorized"
    }

    func accountName(_ id: String) -> String {
        accounts.first { $0.id == id }?.name ?? "Account"
    }

    func personName(_ id: String) -> String {
        people.first { $0.id == id }?.name ?? "Someone"
    }

    /// What a row or split line shows where its category would go: "Owed · Quill" / "Repaid · Quill", or the category name.
    func tagLabel(personId: String?, categoryId: String?, amountCents: Int) -> String {
        guard let personId else { return categoryName(categoryId) }
        return "\(amountCents < 0 ? "Owed" : "Repaid") · \(personName(personId))"
    }

    private func configure(url: URL, token: String, migratingReceipts: Bool = false) {
        session += 1
        referenceRefresh.invalidate()
        let migrate = migratingReceipts && !UserDefaults.standard.bool(forKey: "receiptQueueScoped")
        if receiptQueue.selectServer(url, migratingLegacy: migrate) { UserDefaults.standard.set(true, forKey: "receiptQueueScoped") }
        let client = APIClient(baseURL: url, token: token, transport: URLSessionTransport())
        self.client = client
        reader = Reader(client: client, cache: cache)
    }
}
