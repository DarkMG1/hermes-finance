import Foundation
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

    private let keychain = KeychainStore(service: "dev.darkmg1.hermesfinance")
    private let cache: ResponseCache

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        cache = ResponseCache(directory: caches.appending(path: "api-cache"))
        if let url = URL(string: serverURL), !serverURL.isEmpty, let token = keychain.read("apiToken") {
            configure(url: url, token: token)
        }
    }

    var serverURL: String { UserDefaults.standard.string(forKey: "serverURL") ?? "" }

    func connect(urlText: String, token: String) async throws {
        guard let url = URL(string: urlText.trimmingCharacters(in: .whitespaces)), url.scheme == "https", url.host() != nil else {
            throw ConnectError.badURL
        }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await APIClient(baseURL: url, token: trimmedToken, transport: URLSessionTransport()).accounts()
        keychain.write("apiToken", trimmedToken)
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        configure(url: url, token: trimmedToken)
        await refreshReferenceData()
    }

    func disconnect() {
        keychain.delete("apiToken")
        UserDefaults.standard.removeObject(forKey: "serverURL")
        cache.clear()
        client = nil
        reader = nil
        categories = []
        accounts = []
    }

    func refreshReferenceData() async {
        guard let reader else { return }
        if let loaded = try? await reader.read("/v1/categories", as: [Category].self) { categories = loaded.value.filter { !$0.hidden } }
        if let loaded = try? await reader.read("/v1/accounts", as: [Account].self) { accounts = loaded.value }
    }

    func categoryName(_ id: String?) -> String {
        guard let id else { return "Uncategorized" }
        return categories.first { $0.id == id }?.name ?? "Uncategorized"
    }

    func accountName(_ id: String) -> String {
        accounts.first { $0.id == id }?.name ?? "Account"
    }

    private func configure(url: URL, token: String) {
        let client = APIClient(baseURL: url, token: token, transport: URLSessionTransport())
        self.client = client
        reader = Reader(client: client, cache: cache)
    }
}
