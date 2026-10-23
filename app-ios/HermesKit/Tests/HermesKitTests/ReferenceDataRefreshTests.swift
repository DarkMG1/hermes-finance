import Foundation
import Testing
@testable import HermesKit

private actor ReferenceTransport: HTTPTransport {
    private var requests: [HTTPRequest] = []
    private var replies: [CheckedContinuation<HTTPResponse, Never>] = []
    private var waiting: [(Int, CheckedContinuation<Void, Never>)] = []

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        await withCheckedContinuation { reply in
            requests.append(request)
            replies.append(reply)
            let ready = waiting.filter { requests.count >= $0.0 }
            waiting.removeAll { requests.count >= $0.0 }
            for (_, waiter) in ready { waiter.resume() }
        }
    }

    func waitForRequests(_ count: Int) async {
        if requests.count >= count { return }
        await withCheckedContinuation { waiting.append((count, $0)) }
    }

    func finish(_ indices: Range<Int>, name: String) {
        for index in indices {
            let body = requests[index].url.path == "/v1/people"
                ? "[{\"id\":\"p1\",\"name\":\"\(name)\",\"archived\":false,\"balanceCents\":0}]" : "[]"
            replies[index].resume(returning: HTTPResponse(status: 200, body: Data(body.utf8)))
        }
    }

    func paths() -> [String] { requests.map(\.url.path).sorted() }
}

private func referenceReader(_ transport: ReferenceTransport, directory: URL) -> Reader {
    Reader(client: APIClient(baseURL: testBase, token: "t", transport: transport), cache: ResponseCache(directory: directory))
}

@Test(.timeLimit(.minutes(1))) func supersededReadersCannotOverwriteNewestOfflineResponse() async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let cache = ResponseCache(directory: root)
    let transport = ReferenceTransport()
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    let first = Reader(client: client, cache: cache, now: { Date(timeIntervalSince1970: 1) })
    let second = Reader(client: client, cache: cache, now: { Date(timeIntervalSince1970: 2) })
    let old = Task { try await first.read("/v1/people", as: [Person].self) }
    await transport.waitForRequests(1)
    let fresh = Task { try await second.read("/v1/people", as: [Person].self) }
    await transport.waitForRequests(2)
    await transport.finish(1..<2, name: "Synthetic Wren")
    _ = try await fresh.value
    await transport.finish(0..<1, name: "Synthetic Quill")
    _ = try await old.value

    let offline = Reader(client: APIClient(baseURL: testBase, token: "t", transport: FakeTransport([])), cache: cache)
    let cached = try await offline.read("/v1/people", as: [Person].self)
    #expect(cached.fromCache && cached.value.first?.name == "Synthetic Wren")
    #expect(cached.savedAt == Date(timeIntervalSince1970: 2))
}

@MainActor @Test(.timeLimit(.minutes(1))) func independentReferenceReadsRunTogetherAndOverlappingLaunchReadsCoalesce() async {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let transport = ReferenceTransport()
    let reader = referenceReader(transport, directory: root)
    let refresh = ReferenceDataRefresh()
    let first = refresh.request(using: reader, coalescing: true)
    let second = refresh.request(using: reader, coalescing: true)
    // All three reads must start before any response is released.
    await transport.waitForRequests(3)
    let paths = await transport.paths()
    #expect(paths == ["/v1/accounts", "/v1/categories", "/v1/people"])
    await transport.finish(0..<3, name: "Synthetic Quill")
    let one = await first.value
    let two = await second.value
    #expect(one?.people?.first?.name == "Synthetic Quill" && two?.people?.first?.name == "Synthetic Quill")
    if let one {
        #expect(refresh.isCurrent(one))
        refresh.invalidate()
        #expect(!refresh.isCurrent(one))
    }
}

@MainActor @Test(.timeLimit(.minutes(1))) func editRefreshSupersedesOlderReferenceReadsAndDisconnectInvalidatesThem() async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let transport = ReferenceTransport()
    let reader = referenceReader(transport, directory: root)
    let refresh = ReferenceDataRefresh()
    let old = refresh.request(using: reader, coalescing: true)
    await transport.waitForRequests(3)
    let saved = refresh.request(using: reader, coalescing: false)
    await transport.waitForRequests(6)
    await transport.finish(3..<6, name: "Synthetic Wren")
    let latest = await saved.value
    #expect(latest?.people?.first?.name == "Synthetic Wren")
    await transport.finish(0..<3, name: "Synthetic Quill")
    let stale = await old.value
    #expect(stale == nil)
    let disconnected = refresh.request(using: reader, coalescing: true)
    await transport.waitForRequests(9)
    refresh.invalidate()
    await transport.finish(6..<9, name: "Synthetic Moss")
    let discarded = await disconnected.value
    #expect(discarded == nil)
    let offline = Reader(client: APIClient(baseURL: testBase, token: "t", transport: FakeTransport([])), cache: ResponseCache(directory: root))
    let cached = try await offline.read("/v1/people", query: [URLQueryItem(name: "all", value: "1")], as: [Person].self)
    #expect(cached.fromCache && cached.value.first?.name == "Synthetic Wren")
}
