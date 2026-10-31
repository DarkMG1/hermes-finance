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
    #expect(d.messages.count == 2 && d.messages[1].tools[0].name == "spending" && d.messages[1].tools[0].label == nil)
    #expect(d.messages[1].tools[0].input["period"] == .string("month"))
    #expect(try decode(AiUsage.self, "ai-usage") == AiUsage(month: "2026-03", costCents: 42, backupActive: false))
}

@Test func olderServerMessageWithoutErrorCodeDecodes() throws {
    var obj = try #require(JSONSerialization.jsonObject(with: fixture("chat-detail")) as? [String: Any])
    var msgs = try #require(obj["messages"] as? [[String: Any]])
    for i in msgs.indices { msgs[i].removeValue(forKey: "errorCode") }
    obj["messages"] = msgs
    let d = try JSONDecoder().decode(ChatDetail.self, from: JSONSerialization.data(withJSONObject: obj))
    #expect(d.messages.allSatisfy { $0.errorCode == nil })
}

@Test func jsonValueDisplay() {
    #expect(JSONValue.object(["n": .number(2), "p": .number(1.5), "s": .string("x")]).display == "n: 2, p: 1.5, s: x")
    #expect(JSONValue.number(1234567).display == "1234567" && JSONValue.number(-0.25).display == "-0.25")
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
    ])
    let client = APIClient(baseURL: testBase, token: "t", transport: transport)
    #expect(try await client.createChat(idempotencyKey: "k1").id == "c2")
    try await client.deleteChat(id: "c2")
    let (create, delete) = (transport.requests[0], transport.requests[1])
    #expect(create.body == Data("{}".utf8))
    #expect(create.method == "POST" && create.url.path() == "/v1/chats" && create.headers["Idempotency-Key"] == "k1")
    #expect(delete.method == "DELETE" && delete.url.path() == "/v1/chats/c2" && delete.headers["Idempotency-Key"] == nil)
}
