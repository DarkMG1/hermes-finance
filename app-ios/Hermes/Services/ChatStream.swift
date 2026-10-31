import Foundation
import HermesKit

/// Streams one answer. Cancelling the calling task only drops the connection: the server still finishes and saves the answer.
@MainActor
enum ChatStream {
    static func send(client: APIClient, chatId: String, clientId: String, text: String, onEvent: (ChatEvent) -> Void) async throws {
        let (url, headers) = client.streamRequest(path: "/v1/chats/\(chatId)/messages")
        var request = URLRequest(url: url, timeoutInterval: 300)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["clientId": clientId, "text": text])
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let (bytes, response) = try await URLSessionTransport.session.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            throw ClientError.api(status: status, body: (try? JSONDecoder().decode(APIErrorBody.self, from: data))
                ?? APIErrorBody(code: "HTTP_\(status)", message: "Unexpected server response (\(status))."))
        }
        // whole lines only, so a multi-byte character split across reads still decodes
        var parser = SSEParser(), line = Data()
        for try await byte in bytes {
            line.append(byte)
            guard byte == UInt8(ascii: "\n") else { continue }
            parser.feed(String(bytes: line, encoding: .utf8) ?? "").forEach(onEvent)
            line.removeAll(keepingCapacity: true)
        }
    }
}
