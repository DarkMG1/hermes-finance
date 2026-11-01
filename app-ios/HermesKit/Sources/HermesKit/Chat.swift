import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), null, array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([JSONValue].self) {
            self = .array(v)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

}

public struct ChatSummary: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
}

public struct ChatList: Codable, Sendable { public let chats: [ChatSummary] }

/// `label` is absent from older servers; show the name then.
public struct ChatToolUse: Codable, Sendable, Equatable {
    public let name: String
    public let input: [String: JSONValue]
    public var label: String?
}

/// A `show_chart` tool use the app can draw; nil for any other tool or input it can't, which then shows as a plain tool line.
public struct ChatChart: Equatable, Sendable {
    public enum Kind: String, Sendable { case bar, line }
    public enum Unit: String, Sendable { case usdCents = "usd_cents", count, percent }
    public struct Point: Equatable, Sendable {
        public let label: String
        public let value: Double
    }

    public let kind: Kind
    public let title: String
    public let unit: Unit
    public let points: [Point]

    /// The server's show_chart schema (strict keys, lengths in UTF-16 units like JavaScript), so a chart it rejected shows as a plain line.
    public init?(_ tool: ChatToolUse) {
        guard tool.name == "show_chart", Set(tool.input.keys) == ["kind", "title", "unit", "points"],
              case .string(let kind)? = tool.input["kind"], let kind = Kind(rawValue: kind),
              case .string(let title)? = tool.input["title"], (1...60).contains(title.utf16.count),
              case .string(let unit)? = tool.input["unit"], let unit = Unit(rawValue: unit),
              case .array(let raw)? = tool.input["points"], (2...31).contains(raw.count) else { return nil }
        var points: [Point] = []
        for item in raw {
            // the bound keeps Money.format's Int conversion from trapping
            guard case .object(let point) = item, Set(point.keys) == ["label", "value"],
                  case .string(let label)? = point["label"], (1...24).contains(label.utf16.count),
                  case .number(let value)? = point["value"], abs(value) < 1e15, unit != .usdCents || value == value.rounded() else { return nil }
            points.append(Point(label: label, value: value))
        }
        (self.kind, self.title, self.unit, self.points) = (kind, title, unit, points)
    }

    /// `percent` values are percentage points (12.5 is 12.5%).
    public func format(_ value: Double) -> String {
        switch unit {
        case .usdCents: Money.format(Int(value.rounded()))
        case .count: value.formatted(.number.precision(.fractionLength(0...1)))
        case .percent: (value / 100).formatted(.percent.precision(.fractionLength(0...1)))
        }
    }

    /// Local dates when every label is YYYY-MM or YYYY-MM-DD, so a line can use a time axis.
    public var dates: [Date]? {
        let style = Date.ISO8601FormatStyle(timeZone: .current).year().month().day()
        let dates = points.compactMap { point in
            [7, 10].contains(point.label.count) ? try? Date(point.label.count == 7 ? point.label + "-01" : point.label, strategy: style) : nil
        }
        return dates.count == points.count ? dates : nil
    }
}

public struct ChatMessage: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var role: String
    public var text: String
    public var tools: [ChatToolUse]
    public var status: String
    public var errorCode: String?
    public var createdAt: String
}

public struct ChatDetail: Codable, Sendable {
    public let id: String
    public let title: String
    public let messages: [ChatMessage]
}

public struct AiUsage: Codable, Sendable, Equatable {
    public let month: String
    public let costCents: Int
    public let backupActive: Bool
}

public enum ChatEvent: Equatable, Sendable {
    case tool(name: String, label: String, input: [String: JSONValue]), text(String), done(messageId: String, status: String), error(code: String)
}

/// Feeds raw stream text in arbitrary chunks; returns the complete events seen so far.
public struct SSEParser: Sendable {
    private var buffer = ""
    public init() {}

    public mutating func feed(_ chunk: String) -> [ChatEvent] {
        buffer = (buffer + chunk).replacingOccurrences(of: "\r\n", with: "\n")
        var events: [ChatEvent] = []
        while let end = buffer.range(of: "\n\n") {
            if let event = Self.event(String(buffer[..<end.lowerBound])) { events.append(event) }
            buffer.removeSubrange(..<end.upperBound)
        }
        return events
    }

    private struct Data: Decodable {
        var name, label, text, messageId, status, code: String?
        var input: [String: JSONValue]?
    }

    /// The SSE spec strips one leading space after the colon, no more.
    static func dataValue(_ line: some StringProtocol) -> String {
        let value = line.dropFirst(5)
        return String(value.hasPrefix(" ") ? value.dropFirst() : value)
    }

    private static func event(_ block: String) -> ChatEvent? {
        var name = "", data: [String] = []
        for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("event:") {
                name = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                data.append(dataValue(line))
            }
        }
        guard let d = try? JSONDecoder().decode(Data.self, from: Foundation.Data(data.joined(separator: "\n").utf8)) else { return nil }
        switch name {
        case "tool": return d.name.map { .tool(name: $0, label: d.label ?? $0, input: d.input ?? [:]) }
        case "text": return d.text.map { .text($0) }
        case "done": return d.messageId.map { .done(messageId: $0, status: d.status ?? "done") }
        case "error": return d.code.map { .error(code: $0) }
        default: return nil
        }
    }
}

/// The conversation the screen shows while an answer streams. Tools live on the message, so they survive its id change on done.
public struct ChatThread: Sendable, Equatable {
    public var messages: [ChatMessage]
    public init(_ detail: ChatDetail) { messages = detail.messages }
    public init() { messages = [] }

    public var isStreaming: Bool { messages.last?.status == "streaming" }

    /// Send turns into Stop where it stands, so a second tap meant for Send would stop the answer it just sent.
    /// Stop counts once 1.5 s have passed or the answer has started; with no `sentAt` (an answer from an earlier visit) it always counts.
    public func acceptsStop(sentAt: Date?, now: Date) -> Bool {
        guard let sentAt, let last = messages.last else { return true }
        return now.timeIntervalSince(sentAt) >= 1.5 || !last.text.isEmpty || !last.tools.isEmpty
    }

    public mutating func send(text: String, clientId: String, now: String) {
        guard !isStreaming else { return }
        messages.append(ChatMessage(id: clientId, role: "user", text: text, tools: [], status: "done", errorCode: nil, createdAt: now))
        messages.append(ChatMessage(id: clientId + "-answer", role: "assistant", text: "", tools: [], status: "streaming", errorCode: nil, createdAt: now))
    }

    public mutating func apply(_ event: ChatEvent) {
        guard isStreaming else { return }
        switch event {
        case .tool(let name, let label, let input): messages[messages.count - 1].tools.append(ChatToolUse(name: name, input: input, label: label))
        case .text(let t): messages[messages.count - 1].text += t
        case .done(let id, let status): messages[messages.count - 1].id = id; messages[messages.count - 1].status = status
        case .error(let code): fail(code: code)
        }
    }

    public mutating func stop() {
        if isStreaming { messages[messages.count - 1].status = "stopped" }
    }

    public mutating func fail(code: String) {
        guard isStreaming else { return }
        messages[messages.count - 1].status = "failed"
        messages[messages.count - 1].errorCode = code
    }
}

extension APIClient {
    public func chats() async throws -> ChatList { try decode(try await getData("/v1/chats")) }

    public func createChat(idempotencyKey: String) async throws -> ChatSummary {
        try await write("POST", "/v1/chats", body: [String: String](), key: idempotencyKey)
    }

    public func chat(id: String) async throws -> ChatDetail { try decode(try await getData("/v1/chats/\(id)")) }

    public func deleteChat(id: String) async throws {
        try await send("DELETE", "/v1/chats/\(id)", body: nil, idempotencyKey: nil, timeout: 20)
    }

    /// Returns once the server has saved the running answer as stopped, or at once when nothing is running.
    public func stopChat(id: String) async throws {
        try await send("POST", "/v1/chats/\(id)/stop", body: nil, idempotencyKey: nil, timeout: 30)
    }

    public func aiUsage() async throws -> AiUsage { try decode(try await getData("/v1/ai/usage")) }

    /// The app streams with URLSession itself (Linux Foundation has no byte streams); this keeps the token inside the client.
    public func streamRequest(path: String) -> (url: URL, headers: [String: String]) {
        (baseURL.appending(path: path), ["Authorization": "Bearer \(token)", "Accept": "text/event-stream", "Content-Type": "application/json"])
    }
}
