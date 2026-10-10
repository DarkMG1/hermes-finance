import Foundation
import Testing
@testable import HermesKit

private func tempCache() -> ResponseCache {
    ResponseCache(directory: FileManager.default.temporaryDirectory.appending(path: "hermes-cache-\(UUID().uuidString)"))
}

@Test func readStoresAndFallsBackToCacheOnlyOnTransportErrors() async throws {
    let cache = tempCache()
    let t1 = Date(timeIntervalSince1970: 1_000)
    let homeTransport = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("home")))])
    let online = Reader(client: APIClient(baseURL: testBase, token: "t", transport: homeTransport), cache: cache, now: { t1 })
    let fresh = try await online.read("/v1/home", as: Home.self)
    #expect(!fresh.fromCache && fresh.savedAt == t1)

    let offline = Reader(client: APIClient(baseURL: testBase, token: "t", transport: FakeTransport([])), cache: cache)
    let cached = try await offline.read("/v1/home", as: Home.self)
    #expect(cached.fromCache && cached.savedAt == t1 && cached.value.recent.count == 6)

    let denied = FakeTransport([FakeTransport.json(401, #"{"code":"UNAUTHORIZED","message":"missing or invalid token"}"#)])
    let unauthorized = Reader(client: APIClient(baseURL: testBase, token: "bad", transport: denied), cache: cache)
    await #expect(throws: ClientError.self) { try await unauthorized.read("/v1/home", as: Home.self) }
}

@Test func cacheKeysIncludeTheQuery() async throws {
    let cache = tempCache()
    let page = try fixture("transactions-page")
    let pageTransport = FakeTransport([.success(HTTPResponse(status: 200, body: page))])
    let online = Reader(client: APIClient(baseURL: testBase, token: "t", transport: pageTransport), cache: cache)
    _ = try await online.read("/v1/transactions", query: [URLQueryItem(name: "q", value: "a")], as: TransactionPage.self)
    let offline = Reader(client: APIClient(baseURL: testBase, token: "t", transport: FakeTransport([])), cache: cache)
    await #expect(throws: ClientError.self) {
        try await offline.read("/v1/transactions", query: [URLQueryItem(name: "q", value: "b")], as: TransactionPage.self)
    }
}

@Test func gatewayErrorsFallBackToCacheButServerErrorsThrow() async throws {
    let cache = tempCache()
    let seed = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("home")))])
    _ = try await Reader(client: APIClient(baseURL: testBase, token: "t", transport: seed), cache: cache).read("/v1/home", as: Home.self)

    let bad = FakeTransport([FakeTransport.json(502, "<html>Bad Gateway</html>")])
    let cached = try await Reader(client: APIClient(baseURL: testBase, token: "t", transport: bad), cache: cache).read("/v1/home", as: Home.self)
    #expect(cached.fromCache && cached.value.recent.count == 6)

    let broken = FakeTransport([FakeTransport.json(500, #"{"code":"INTERNAL","message":"x"}"#)])
    let reader = Reader(client: APIClient(baseURL: testBase, token: "t", transport: broken), cache: cache)
    await #expect(throws: ClientError.self) { try await reader.read("/v1/home", as: Home.self) }
}

@Test func queryValuesCannotCollideAcrossKeys() async throws {
    let cache = tempCache()
    let seed = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("transactions-page")))])
    _ = try await Reader(client: APIClient(baseURL: testBase, token: "t", transport: seed), cache: cache)
        .read("/v1/transactions", query: [URLQueryItem(name: "q", value: "a&cursor=c")], as: TransactionPage.self)
    let offline = Reader(client: APIClient(baseURL: testBase, token: "t", transport: FakeTransport([])), cache: cache)
    await #expect(throws: ClientError.self) {
        try await offline.read("/v1/transactions", query: [URLQueryItem(name: "q", value: "a"), URLQueryItem(name: "cursor", value: "c")],
                               as: TransactionPage.self)
    }
}
