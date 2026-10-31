import HermesKit
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    /// nil until the first question creates the chat.
    @State var chatId: String?
    @State private var title = ""
    @State private var thread: ChatThread?
    @State private var loadError: String?
    @State private var draft = ""
    @State private var stream: Task<Void, Never>?
    @State private var backupActive = false
    @State private var shownTool: ChatToolUse?
    @State private var createKey = UUID().uuidString

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.m) {
                InlineError(message: loadError)
                ForEach(thread?.messages ?? []) { message in
                    if message.role == "user" { userBubble(message) } else { answer(message) }
                }
            }
            .padding(Space.l)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        .safeAreaInset(edge: .top) {
            if backupActive { Text("Using backup key").textStyle(.caption, color: Palette.secondaryText) }
        }
        .safeAreaInset(edge: .bottom) { input }
        .navigationTitle(title.isEmpty ? "New chat" : title)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: Binding(get: { shownTool != nil }, set: { if !$0 { shownTool = nil } })) {
            if let tool = shownTool {
                // swiftlint:disable:next multiple_closures_with_trailing_closure
                Sheet(title: tool.name, dirty: false, onCancel: { shownTool = nil }, onSave: nil) {
                    ForEach(tool.input.keys.sorted(), id: \.self) { LabeledContent($0, value: tool.input[$0]?.display ?? "") }
                }
            }
        }
        .task { await load() }
        .task { backupActive = (try? await model.client?.aiUsage())?.backupActive ?? false }
        // an answer still being written by an earlier visit: look again until it ends
        .task(id: thread?.isStreaming == true && stream == nil) {
            while thread?.isStreaming == true, stream == nil, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await load()
            }
        }
    }

    private func userBubble(_ message: ChatMessage) -> some View {
        HStack {
            Spacer(minLength: Space.xxl)
            Text(message.text).textStyle(.body, color: .white)
                .padding(Space.m)
                .background(Palette.accent, in: RoundedRectangle(cornerRadius: Radius.medium))
        }
    }

    private func answer(_ message: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(Array(message.tools.enumerated()), id: \.offset) { _, tool in
                Button { shownTool = tool } label: { Text(tool.label ?? tool.name).textStyle(.caption, color: Palette.secondaryText) }
                    .buttonStyle(.plain)
            }
            if !message.text.isEmpty {
                Text((try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
                     ?? AttributedString(message.text))
                    .textStyle(.body)
                    .textSelection(.enabled)
            }
            switch message.status {
            case "streaming" where message.text.isEmpty: ProgressView()
            case "stopped": Text("Stopped").textStyle(.caption, color: Palette.secondaryText)
            case "failed": failure(message)
            default: EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func failure(_ message: ChatMessage) -> some View {
        switch message.errorCode {
        case "AI_CREDITS_EXHAUSTED": Text("AI credits used up for this month").textStyle(.caption, color: Palette.loss)
        case "AI_NOT_CONFIGURED": Text("AI isn't set up on the server").textStyle(.caption, color: Palette.loss)
        default:
            Button("Couldn't answer · Retry") { retry() }.textStyle(.caption, color: Palette.loss).disabled(stream != nil)
        }
    }

    private var input: some View {
        let streaming = thread?.isStreaming == true
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(alignment: .bottom, spacing: Space.s) {
            TextField("Ask about your money", text: $draft, axis: .vertical).lineLimit(1...5).textStyle(.body)
            Button(streaming ? "Stop" : "Send", systemImage: streaming ? "stop.circle.fill" : "arrow.up.circle.fill") {
                if streaming { stop() } else { send(text) }
            }
            .labelStyle(.iconOnly)
            .font(TextStyle.title.font)
            // a stream left over from an earlier visit can't be stopped from here
            .disabled(thread == nil || (streaming ? stream == nil : stream != nil || text.isEmpty || text.count > 4000))
        }
        .padding(Space.m)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.medium))
        .padding(Space.s)
    }

    /// `resync`: after a local failure, take the server's version only if it kept the question, so an unsent one stays retryable.
    private func load(resync: Bool = false) async {
        guard let chatId else {
            thread = thread ?? ChatThread()
            return
        }
        guard let client = model.client else { return }
        do {
            let detail = try await client.chat(id: chatId)
            guard stream == nil, !resync || detail.messages.count >= thread?.messages.count ?? 0 else { return }
            thread = ChatThread(detail)
            title = detail.title
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = errorMessage(error)
        }
    }

    private func send(_ text: String) {
        draft = ""
        if title.isEmpty { title = String(text.prefix(60)) }
        ask(text, clientId: UUID().uuidString)
    }

    /// Resends the failed question with its own id: the server reruns a failed answer for the same clientId.
    /// A question loaded from the server carries its row id instead, which works too, since a failed pair is replaced either way.
    private func retry() {
        guard let question = thread?.messages.dropLast().last, question.role == "user" else { return }
        ask(question.text, clientId: question.id)
    }

    private func ask(_ text: String, clientId: String) {
        guard let client = model.client else { return }
        // the server replaces a failed answer and its question with the next one
        if thread?.messages.last?.status == "failed" {
            thread?.messages.removeLast()
            if thread?.messages.last?.role == "user" { thread?.messages.removeLast() }
        }
        thread?.send(text: text, clientId: clientId, now: Date().ISO8601Format())
        stream = Task {
            do {
                if chatId == nil { chatId = try await client.createChat(idempotencyKey: createKey).id }
                try await ChatStream.send(client: client, chatId: chatId ?? "", clientId: clientId, text: text) { thread?.apply($0) }
            } catch ClientError.api(_, let body) {
                thread?.fail(code: body.code)
            } catch {
                thread?.fail(code: "NETWORK")
            }
            // ended without done or error; a no-op once the answer has an outcome
            thread?.fail(code: "INTERRUPTED")
            stream = nil
            // the server may have saved a different outcome (done, stopped) than the connection showed
            if ["NETWORK", "INTERRUPTED"].contains(thread?.messages.last?.errorCode) { await load(resync: true) }
        }
    }

    private func stop() {
        thread?.stop()
        stream?.cancel()
    }
}
