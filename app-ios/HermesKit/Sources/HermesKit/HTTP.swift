import Foundation

public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    public var timeout: TimeInterval
}

public struct HTTPResponse: Sendable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

/// URLSession lives in the app target; HermesKit stays Foundation-only so it tests on Linux.
public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

public enum ClientError: Error, Equatable, Sendable {
    case api(status: Int, body: APIErrorBody)
    case transport(String)
    case decoding(String)

    /// The server may have committed the write: retry only with the same key and body.
    public var isOutcomeUnknown: Bool {
        switch self {
        case .transport, .decoding: true
        case .api(let status, _): status >= 500
        }
    }

    public var message: String {
        switch self {
        case .api(401, _): "The server rejected the token."
        case .api(_, let body): body.message
        case .transport: "Can't reach the server."
        case .decoding: "The server sent something this app version doesn't understand."
        }
    }
}
