import Foundation

public struct Loaded<Value: Sendable>: Sendable {
    public let value: Value
    public let savedAt: Date
    public let fromCache: Bool
}

/// Reads go to the server; when the server can't be reached the last good response is served instead.
public struct Reader: Sendable {
    private let client: APIClient
    private let cache: ResponseCache
    private let now: @Sendable () -> Date
    // fixed for this Reader's lifetime: after a sign-out clears the cache, nothing this Reader reads is stored again
    private let generation: Int

    public init(client: APIClient, cache: ResponseCache, now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.cache = cache
        self.now = now
        generation = cache.currentGeneration
    }

    // nginx answers 502-504 when the Node server is down
    private static func isServerDown(_ error: ClientError) -> Bool {
        switch error {
        case .transport: true
        case .api(let status, _): (502...504).contains(status)
        case .decoding: false
        }
    }

    public func read<Value: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], as type: Value.Type) async throws -> Loaded<Value> {
        var keyParts = URLComponents()
        keyParts.queryItems = query.isEmpty ? nil : query
        // keyed by server too, so one server's cached data is never served for another
        let key = client.baseURL.absoluteString + path + "?" + (keyParts.percentEncodedQuery ?? "")
        let request = cache.beginRead(key: key, generation: generation)
        do {
            let data = try await client.getData(path, query: query)
            let value: Value = try client.decode(data)
            let savedAt = now()
            if !Task.isCancelled { cache.store(data, key: key, savedAt: savedAt, generation: generation, request: request) }
            return Loaded(value: value, savedAt: savedAt, fromCache: false)
        } catch let error as ClientError {
            guard Self.isServerDown(error), let hit = cache.load(key: key) else { throw error }
            return Loaded(value: try client.decode(hit.data), savedAt: hit.savedAt, fromCache: true)
        }
    }
}
