import Foundation

public final class APIClient: Sendable {
    public let baseURL: URL
    private let token: String
    private let transport: any HTTPTransport

    public init(baseURL: URL, token: String, transport: any HTTPTransport) {
        self.baseURL = baseURL
        self.token = token
        self.transport = transport
    }

    public func getData(_ path: String, query: [URLQueryItem] = []) async throws -> Data {
        try await send("GET", path, query: query, body: nil, idempotencyKey: nil, timeout: 20).body
    }

    public func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw ClientError.decoding(String(describing: error)) }
    }

    func write<B: Encodable, T: Decodable>(_ method: String, _ path: String, body: B, key: String, timeout: TimeInterval = 30) async throws -> T {
        let data = try JSONEncoder().encode(body)
        return try decode(try await send(method, path, body: data, idempotencyKey: key, timeout: timeout).body)
    }

    @discardableResult
    func send(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data?,
              idempotencyKey: String?, timeout: TimeInterval) async throws -> HTTPResponse {
        guard var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false) else {
            throw ClientError.transport("bad server address")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw ClientError.transport("bad server address") }
        var headers = ["Authorization": "Bearer \(token)", "Accept": "application/json"]
        if body != nil { headers["Content-Type"] = "application/json" }
        if let idempotencyKey { headers["Idempotency-Key"] = idempotencyKey }
        let response: HTTPResponse
        do {
            response = try await transport.send(HTTPRequest(method: method, url: url, headers: headers, body: body, timeout: timeout))
        } catch {
            throw ClientError.transport(String(describing: error))
        }
        guard (200..<300).contains(response.status) else {
            let body = (try? JSONDecoder().decode(APIErrorBody.self, from: response.body))
                ?? APIErrorBody(code: "HTTP_\(response.status)", message: "Unexpected server response (\(response.status)).")
            throw ClientError.api(status: response.status, body: body)
        }
        return response
    }
}
