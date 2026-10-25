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

@Test func cachedResponsesAreNeverServedForADifferentServer() async throws {
    let cache = tempCache()
    let seed = FakeTransport([.success(HTTPResponse(status: 200, body: try fixture("home")))])
    _ = try await Reader(client: APIClient(baseURL: testBase, token: "t", transport: seed), cache: cache).read("/v1/home", as: Home.self)

    let otherServer = try #require(URL(string: "https://other.example.test"))
    let down = FakeTransport([FakeTransport.json(503, "<html>Service Unavailable</html>")])
    let other = Reader(client: APIClient(baseURL: otherServer, token: "t", transport: down), cache: cache)
    await #expect(throws: ClientError.self) { try await other.read("/v1/home", as: Home.self) }
}

@Test func aStoreStartedBeforeAClearIsDropped() throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: "cache-gen-\(UUID().uuidString)")
    let cache = ResponseCache(directory: dir)
    let before = cache.currentGeneration
    cache.clear()
    cache.store(Data("{}".utf8), key: "k", savedAt: Date(timeIntervalSince1970: 0), generation: before)
    #expect(cache.load(key: "k") == nil)
    cache.store(Data("{}".utf8), key: "k", savedAt: Date(timeIntervalSince1970: 0), generation: cache.currentGeneration)
    #expect(cache.load(key: "k") != nil)
}

private struct ClearingTransport: HTTPTransport {
    let cache: ResponseCache
    let body: Data
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        cache.clear()
        return HTTPResponse(status: 200, body: body)
    }
}

@Test func aReadThatOverlapsAClearDoesNotStoreItsResponse() async throws {
    let cache = tempCache()
    let transport = ClearingTransport(cache: cache, body: try fixture("home"))
    let reader = Reader(client: APIClient(baseURL: testBase, token: "t", transport: transport), cache: cache)
    _ = try await reader.read("/v1/home", as: Home.self)
    let key = testBase.absoluteString + "/v1/home?"
    #expect(cache.load(key: key) == nil)
}

@Test func aReaderMadeBeforeAClearNeverStoresAgain() async throws {
    let cache = tempCache()
    let key = testBase.absoluteString + "/v1/home?"
    let home = try fixture("home")
    let old = Reader(client: APIClient(baseURL: testBase, token: "t", transport: FakeTransport([.success(HTTPResponse(status: 200, body: home))])),
                     cache: cache)
    cache.clear()
    _ = try await old.read("/v1/home", as: Home.self)
    #expect(cache.load(key: key) == nil)

    let fresh = Reader(client: APIClient(baseURL: testBase, token: "t", transport: FakeTransport([.success(HTTPResponse(status: 200, body: home))])),
                       cache: cache)
    _ = try await fresh.read("/v1/home", as: Home.self)
    #expect(cache.load(key: key) != nil)
}

@Test func cacheOrdersRequestsPerKeyEvenWhenTheLatestRequestFails() throws {
    let cache = tempCache()
    defer { cache.clear() }
    let generation = cache.currentGeneration
    let savedAt = Date(timeIntervalSince1970: 1)
    let current = Data("current".utf8)
    cache.store(Data("previous".utf8), key: "a", savedAt: savedAt, generation: generation)
    let first = cache.beginRead(key: "a", generation: generation)
    let other = cache.beginRead(key: "b", generation: generation)
    cache.store(Data("other".utf8), key: "b", savedAt: savedAt, generation: generation, request: other)
    cache.store(current, key: "a", savedAt: savedAt, generation: generation, request: first)
    #expect(cache.load(key: "a")?.data == current && cache.load(key: "b") != nil)
    // The newest read fails, so the previous cached response stays; an older in-flight read must not replace it.
    _ = cache.beginRead(key: "a", generation: generation)
    cache.store(Data("stale".utf8), key: "a", savedAt: savedAt, generation: generation, request: first)
    #expect(cache.load(key: "a")?.data == current)

    cache.clear()
    let fresh = cache.beginRead(key: "a", generation: cache.currentGeneration)
    let stale = cache.beginRead(key: "a", generation: generation)
    #expect(stale == nil)
    cache.store(current, key: "a", savedAt: savedAt, generation: cache.currentGeneration, request: fresh)
    cache.store(Data("stale".utf8), key: "a", savedAt: savedAt, generation: generation, request: first)
    #expect(cache.load(key: "a")?.data == current)
}
