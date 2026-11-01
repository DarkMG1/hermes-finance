import Foundation
import Testing
@testable import HermesKit

@Test func parserHandlesSplitChunksCommentsAndMultiLineData() {
    var p = SSEParser()
    #expect(p.feed("event: text\ndata: {\"text\":\"Hi") == [])
    let events = p.feed(" there\"}\n\n: keepalive\n\nevent: done\ndata: {\"messageId\":\"m1\",\n" +
                        "data: \"costCents\":3,\"status\":\"stopped\"}\n\nevent: other\ndata: {}\n\n")
    #expect(events == [.text("Hi there"), .done(messageId: "m1", status: "stopped")])
}

@Test func parserHandlesCRLFAndToolAndError() {
    var p = SSEParser()
    let tool = "{\"type\":\"tool\",\"name\":\"spending\",\"label\":\"Spending\",\"input\":{\"n\":2,\"d\":\"x\"}}"
    let raw = "event: tool\r\ndata: \(tool)\r\n\r\nevent: error\r\ndata: {\"code\":\"AI_FAILED\"}\r\n\r\n"
    var events = p.feed(String(raw.prefix(20)))
    events += p.feed(String(raw.dropFirst(20)))
    #expect(events == [.tool(name: "spending", label: "Spending", input: ["n": .number(2), "d": .string("x")]), .error(code: "AI_FAILED")])
}

private func streaming() -> ChatThread {
    var t = ChatThread(ChatDetail(id: "c", title: "t", messages: []))
    t.send(text: "Q", clientId: "u1", now: "2026-03-15T12:00:00.000Z")
    return t
}

@Test func threadAppliesToolTextDone() {
    var t = streaming()
    #expect(t.isStreaming && t.messages.map(\.role) == ["user", "assistant"])
    t.apply(.tool(name: "spending", label: "Spending · 2026-09", input: ["date": .string("2026-09")]))
    t.apply(.text("A")); t.apply(.text("B"))
    t.apply(.done(messageId: "m9", status: "done"))
    let m = t.messages[1]
    #expect(m.text == "AB" && m.status == "done" && m.id == "m9" && !t.isStreaming)
    #expect(m.tools.map(\.label) == ["Spending · 2026-09"] && m.tools[0].input == ["date": .string("2026-09")])
}

@Test func doneCanBeStopped() {
    var t = streaming()
    t.apply(.text("A")); t.apply(.done(messageId: "m9", status: "stopped"))
    #expect(t.messages[1].status == "stopped" && !t.isStreaming)
}

@Test func stopKeepsPartialText() {
    var t = streaming()
    t.apply(.text("part")); t.stop()
    #expect(t.messages[1].text == "part" && t.messages[1].status == "stopped" && !t.isStreaming)
}

@Test func errorMarksFailedWithCode() {
    var t = streaming()
    t.apply(.error(code: "AI_FAILED"))
    #expect(t.messages[1].status == "failed" && t.messages[1].errorCode == "AI_FAILED" && !t.isStreaming)
    var u = streaming(); u.fail(code: "NETWORK")
    #expect(u.messages[1].errorCode == "NETWORK")
}

@Test func chatFixturesDecode() throws {
    #expect(try decode(ChatList.self, "chat-list").chats.map(\.id) == ["chat-1"])
    let d = try decode(ChatDetail.self, "chat-detail")
    #expect(d.messages.count == 2 && d.messages[1].tools[0].name == "spending" && d.messages[1].tools[0].label == "Spending · March 2026")
    #expect(d.messages[1].tools[0].input["period"] == .string("month"))
    #expect(try decode(AiUsage.self, "ai-usage") == AiUsage(month: "2026-03", costCents: 42, backupActive: false))
}

@Test func olderServerMessageWithoutErrorCodeDecodes() throws {
    var obj = try #require(JSONSerialization.jsonObject(with: fixture("chat-detail")) as? [String: Any])
    var msgs = try #require(obj["messages"] as? [[String: Any]])
    for i in msgs.indices {
        msgs[i].removeValue(forKey: "errorCode")
        msgs[i]["tools"] = (msgs[i]["tools"] as? [[String: Any]])?.map { $0.filter { $0.key != "label" } }
    }
    obj["messages"] = msgs
    let d = try JSONDecoder().decode(ChatDetail.self, from: JSONSerialization.data(withJSONObject: obj))
    #expect(d.messages.allSatisfy { $0.errorCode == nil } && d.messages[1].tools[0].label == nil)
}

@Test func stopRightAfterSendingIsIgnoredUntilTheAnswerStarts() {
    let sent = Date(timeIntervalSince1970: 1000)
    var t = ChatThread()
    t.send(text: "q", clientId: "u1", now: "n")
    #expect(!t.acceptsStop(sentAt: sent, now: sent.addingTimeInterval(1.4)))
    #expect(t.acceptsStop(sentAt: sent, now: sent.addingTimeInterval(1.5)))
    #expect(t.acceptsStop(sentAt: nil, now: sent))
    var tool = t
    tool.apply(.tool(name: "spending", label: "Spending", input: [:]))
    #expect(tool.acceptsStop(sentAt: sent, now: sent.addingTimeInterval(0.2)))
    t.apply(.text("A"))
    #expect(t.acceptsStop(sentAt: sent, now: sent.addingTimeInterval(0.2)))
}

private func chart(_ input: [String: JSONValue], name: String = "show_chart") -> ChatChart? {
    ChatChart(ChatToolUse(name: name, input: input, label: nil))
}

private let points: JSONValue = .array([.object(["label": .string("2026-09"), "value": .number(12345)]),
                                        .object(["label": .string("2026-10"), "value": .number(-50)])])

@Test func chartDecodesValidInput() throws {
    let c = try #require(chart(["kind": .string("line"), "title": .string("Net worth"), "unit": .string("usd_cents"), "points": points]))
    #expect(c.kind == .line && c.title == "Net worth" && c.unit == .usdCents)
    #expect(c.points == [.init(label: "2026-09", value: 12345), .init(label: "2026-10", value: -50)])
    #expect(c.format(12345) == Money.format(12345))
    let dates = try #require(c.dates)
    #expect(Calendar.current.dateComponents([.year, .month, .day], from: dates[1]) == DateComponents(year: 2026, month: 10, day: 1))
}

@Test func chartRejectsInvalidInput() {
    let ok: [String: JSONValue] = ["kind": .string("bar"), "title": .string("T"), "unit": .string("count"), "points": points]
    #expect(chart(ok) != nil)
    #expect(chart(ok, name: "spending") == nil)
    let one: JSONValue = .array([.object(["label": .string("a"), "value": .number(1)])])
    let badPoint: JSONValue = .array([.object(["label": .string("a"), "value": .string("1")]), .object(["label": .string("b"), "value": .number(1)])])
    let longLabel: JSONValue = .array([.object(["label": .string(String(repeating: "x", count: 25)), "value": .number(1)]),
                                       .object(["label": .string("b"), "value": .number(1)])])
    let huge: JSONValue = .array([.object(["label": .string("a"), "value": .number(1e300)]), .object(["label": .string("b"), "value": .number(1)])])
    for (key, value) in [("kind", JSONValue.string("pie")), ("title", .string("")), ("title", .string(String(repeating: "x", count: 61))),
                         ("unit", .string("eur")), ("points", one), ("points", badPoint), ("points", longLabel), ("points", huge),
                         ("points", .array(Array(repeating: .object(["label": .string("a"), "value": .number(1)]), count: 32)))] {
        var input = ok
        input[key] = value
        #expect(chart(input) == nil, "\(key)")
    }
    // the server's strict schema: unknown keys at either level, lengths in UTF-16 units, whole cents
    let extraPoint: JSONValue = .array([.object(["label": .string("a"), "value": .number(1), "color": .string("red")]),
                                        .object(["label": .string("b"), "value": .number(1)])])
    let wideLabel: JSONValue = .array([.object(["label": .string(String(repeating: "💵", count: 13)), "value": .number(1)]),
                                       .object(["label": .string("b"), "value": .number(1)])])
    let halfCent: JSONValue = .array([.object(["label": .string("a"), "value": .number(1.5)]), .object(["label": .string("b"), "value": .number(1)])])
    for input in [ok.merging(["extra": .bool(true)]) { $1 }, ok.merging(["points": extraPoint]) { $1 }, ok.merging(["points": wideLabel]) { $1 },
                  ok.merging(["title": .string(String(repeating: "💵", count: 31))]) { $1 },
                  ok.merging(["unit": .string("usd_cents"), "points": halfCent]) { $1 }] {
        #expect(chart(input) == nil, "\(input)")
    }
    #expect(chart(ok.merging(["points": halfCent]) { $1 }) != nil)
}

@Test func chartFormatsUnitsAndDatesOnlyWhenEveryLabelIsOne() throws {
    let c = try #require(chart(["kind": .string("bar"), "title": .string("T"), "unit": .string("percent"),
                                "points": .array([.object(["label": .string("2026-10-05"), "value": .number(12.5)]),
                                                  .object(["label": .string("Food"), "value": .number(3)])])]))
    #expect(c.dates == nil)
    #expect(c.format(12.5) == (0.125).formatted(.percent.precision(.fractionLength(0...1))))
    let n = try #require(chart(["kind": .string("bar"), "title": .string("T"), "unit": .string("count"), "points": points]))
    #expect(n.format(3) == (3.0).formatted(.number.precision(.fractionLength(0...1))))
    #expect(chart(["kind": .string("bar"), "title": .string("T"), "unit": .string("count"),
                   "points": .array([.object(["label": .string("2026-13"), "value": .number(1)]),
                                     .object(["label": .string("2026-10"), "value": .number(1)])])])?.dates == nil)
}

@Test func dataLineStripsExactlyOneLeadingSpace() {
    #expect(SSEParser.dataValue("data:  x") == " x" && SSEParser.dataValue("data: x") == "x" && SSEParser.dataValue("data:x") == "x")
}

@Test func sendIsIgnoredWhileStreaming() {
    var t = streaming()
    t.send(text: "again", clientId: "u2", now: "n")
    #expect(t.messages.count == 2 && t.isStreaming)
}

@Test func chatEndpoints() async throws {
    let transport = FakeTransport([
        .success(HTTPResponse(status: 201, body: Data(#"{"id":"c2","title":"New chat","createdAt":"a","updatedAt":"b"}"#.utf8))),
        .success(HTTPResponse(status: 204, body: Data())),
        .success(HTTPResponse(status: 204, body: Data())),
    ])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    #expect(try await client.createChat(idempotencyKey: "k1").id == "c2")
    try await client.deleteChat(id: "c2")
    try await client.stopChat(id: "c2")
    let (create, delete, stop) = (transport.requests[0], transport.requests[1], transport.requests[2])
    #expect(create.body == Data("{}".utf8))
    #expect(create.method == "POST" && create.url.path() == "/v1/chats" && create.headers["Idempotency-Key"] == "k1")
    #expect(delete.method == "DELETE" && delete.url.path() == "/v1/chats/c2" && delete.headers["Idempotency-Key"] == nil)
    #expect(stop.method == "POST" && stop.url.path() == "/v1/chats/c2/stop" && stop.body == nil && stop.headers["Idempotency-Key"] == nil)
}

@Test func streamRequestCarriesTokenAndAcceptsEventStream() {
    let (url, headers) = APIClient(baseURL: testBase, token: "t", transport: FakeTransport([])).streamRequest(path: "/v1/chats/c1/messages")
    #expect(url.path() == "/v1/chats/c1/messages" && headers["Authorization"] == "Bearer t" && headers["Accept"] == "text/event-stream")
}

@Test func creditsExhaustedReadsPlainly() {
    #expect(ClientError.api(status: 402, body: APIErrorBody(code: "AI_CREDITS_EXHAUSTED", message: "x")).message == "AI credits used up for this month")
}

@Test func typingPaceKeepsUpAndFlushesWhenEnded() {
    let frame = 1.0 / 60
    // a small backlog types at the base pace, at least one character a frame
    #expect(TypingPace.next(shown: 0, received: 10, elapsed: frame, ended: false) == 2)
    #expect(TypingPace.next(shown: 9, received: 10, elapsed: frame, ended: false) == 10)
    // a large backlog speeds up to clear in about a third of a second, and ended in a tenth
    #expect(TypingPace.next(shown: 0, received: 1200, elapsed: frame, ended: false) == 61)
    #expect(TypingPace.next(shown: 0, received: 1200, elapsed: frame, ended: true) == 200)
    // caught up, or text that shrank (a reload), shows what there is
    #expect(TypingPace.next(shown: 10, received: 10, elapsed: frame, ended: false) == 10)
    #expect(TypingPace.next(shown: 50, received: 10, elapsed: frame, ended: true) == 10)
    // a long stall never overshoots
    #expect(TypingPace.next(shown: 0, received: 10, elapsed: 5, ended: false) == 10)
    // a 1,000-character burst is fully shown within about 1.5 s of frames
    var shown = 0, frames = 0
    while shown < 1000 { shown = TypingPace.next(shown: shown, received: 1000, elapsed: frame, ended: false); frames += 1 }
    #expect(frames <= 90)
}
