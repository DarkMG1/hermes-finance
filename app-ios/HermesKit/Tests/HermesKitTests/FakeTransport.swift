import Foundation
@testable import HermesKit

final class FakeTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [Result<HTTPResponse, Error>]
    private(set) var requests: [HTTPRequest] = []

    init(_ responses: [Result<HTTPResponse, Error>]) { queue = responses }

    static func json(_ status: Int, _ body: String) -> Result<HTTPResponse, Error> {
        .success(HTTPResponse(status: status, body: Data(body.utf8)))
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let next: Result<HTTPResponse, Error> = lock.withLock {
            requests.append(request)
            return queue.isEmpty ? .failure(URLError(.notConnectedToInternet)) : queue.removeFirst()
        }
        return try next.get()
    }
}

let testBase = URL(string: "https://hermes.example.com")!
