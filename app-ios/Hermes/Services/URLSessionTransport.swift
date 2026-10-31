import Foundation
import HermesKit

struct URLSessionTransport: HTTPTransport {
    // ephemeral: no on-disk URL cache, so responses and the bearer request never persist (Reader keeps its own offline copy)
    static let session = URLSession(configuration: .ephemeral)

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url, timeoutInterval: request.timeout)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
        let (data, response) = try await Self.session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return HTTPResponse(status: http.statusCode, body: data)
    }
}
