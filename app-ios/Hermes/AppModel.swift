import Foundation
import UIKit
import HermesKit
// swiftlint:disable:next duplicate_imports
import struct HermesKit.Category
import Observation
import UniformTypeIdentifiers

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
    private(set) var csvImports = CSVImportQueue()
    var importNote: String?
    private var importWrites = WriteGuard()

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
        configure(url: url, token: token)
    }

    var serverURL: String { UserDefaults.standard.string(forKey: "serverURL") ?? "" }

    func connect(urlText: String, token: String) async throws {
        guard let url = URL(string: urlText.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host() != nil else {
            throw ConnectError.badURL
        }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await APIClient(baseURL: url, token: trimmedToken, transport: URLSessionTransport()).accounts()
        try keychain.write("apiToken", trimmedToken)
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        configure(url: url, token: trimmedToken)
        await refreshReferenceData()
    }

    func disconnect() {
        session += 1
        let hadImports = !csvImports.files.isEmpty
        importNote = hadImports ? "Connect to a server before importing an Apple Card CSV." : nil
        for url in csvImports.files { removeInboxCSV(url) }
        csvImports = CSVImportQueue()
        importWrites = WriteGuard()
        referenceRefresh.invalidate()
        receiptQueue.selectServer(nil)
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

    func queueCSV(_ result: Result<URL, Error>) {
        do {
            let opened = try result.get()
            guard opened.isFileURL else { return }
            let url = opened.standardizedFileURL
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let contentType = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType
            guard CSVImportQueue.accepts(url, contentType: contentType) else {
                importNote = "Choose an Apple Card CSV file."
                removeInboxCSV(url)
                return
            }
            csvImports.add(url, fileExists: !isInboxCSV(url) || FileManager.default.fileExists(atPath: url.path()))
        } catch {
            importNote = errorMessage(error)
        }
    }

    func importCSV(ready: Bool) async {
        guard let url = csvImports.begin(ready: ready && importNote == nil) else { return }
        let current = session
        defer {
            if current == session {
                removeInboxCSV(url)
                csvImports.finish()
            }
        }
        guard let client else {
            importNote = "Connect to a server before importing an Apple Card CSV."
            return
        }
        do {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let csv = try String(contentsOf: url, encoding: .utf8)
            let imported = try await client.importAppleCard(csv: csv, idempotencyKey: importWrites.key)
            guard current == session else { return }
            importWrites.didSucceed()
            importNote = "\(imported.rows) rows: \(imported.added) new, \(imported.updated) already imported"
                + (imported.skippedBeforeCutover > 0 ? ", \(imported.skippedBeforeCutover) before the cutover" : "")
            await refreshReferenceData()
        } catch {
            guard current == session else { return }
            if case ClientError.api(409, let body) = error, body.code == "IDEMPOTENCY_KEY_REUSED" {
                importWrites.didSucceed()
                importNote = "The earlier import finished. Import this file again to add it."
                return
            }
            importWrites.didFail(error)
            importNote = importWrites.unresolved ? "Couldn't confirm the import. Import the same file again to finish." : errorMessage(error)
        }
    }

    private func isInboxCSV(_ url: URL) -> Bool {
        CSVImportQueue.isInboxCopy(url, documents: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0])
    }

    func removeStaleInboxCSVs() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let urls = (try? FileManager.default.contentsOfDirectory(at: documents.appending(path: "Inbox"),
                                                               includingPropertiesForKeys: [.isRegularFileKey])) ?? []
        for url in csvImports.staleInboxCopies(urls, documents: documents)
            where (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            removeInboxCSV(url)
        }
    }

    private func removeInboxCSV(_ url: URL) {
        guard isInboxCSV(url), FileManager.default.fileExists(atPath: url.path()) else { return }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            importNote = (importNote.map { $0 + "\n" } ?? "") + "Couldn't remove the copied CSV file."
        }
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

    private func configure(url: URL, token: String) {
        session += 1
        referenceRefresh.invalidate()
        receiptQueue.selectServer(url)
        let client = APIClient(baseURL: url, token: token, transport: URLSessionTransport())
        self.client = client
        reader = Reader(client: client, cache: cache)
    }
}
