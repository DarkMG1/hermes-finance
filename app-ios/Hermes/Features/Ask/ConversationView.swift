import HermesKit
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.askCovered) private var covered
    /// nil until the first question creates the chat.
    @State var chatId: String?
    @State private var title = ""
    @State private var thread: ChatThread?
    @State private var loadError: String?
    @State private var draft = ""
    @State private var stream: Task<Void, Never>?
    @State private var backupActive = false
    /// When the answer now streaming was sent; Stop ignores the send tap's double (see `acceptsStop`).
    @State private var sentAt: Date?
    @State private var createKey = UUID().uuidString
    /// Characters of the last answer typed out so far; nil shows every answer whole, as loaded history does.
    @State private var typed: Int?
    /// Set by a send here: the last exchange then fills the screen, so its question can sit at the top with the answer typing below.
    @State private var pinned = false
    @State private var position = ScrollPosition()
    @State private var visibleHeight: CGFloat = 0
    @State private var atBottom = true
    /// Off after a send, so the answer types below its question; scrolling or jumping to the bottom turns it back on.
    @State private var following = true
    /// The question just sent, scrolled to once its rows are laid out.
    @State private var scrollPending = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

    var body: some View {
        ScrollView {
            // a reader, not `position`, for this scroll: ScrollPosition's scrollTo(id:anchor: .top) lined up the bottom of a
            // pinned exchange taller than the screen
            ScrollViewReader { proxy in
                VStack(alignment: .leading, spacing: Space.m) {
                    InlineError(message: loadError)
                    if thread?.messages.isEmpty == true {
                        Text("Ask about your spending, bills, IOUs or investments").textStyle(.subhead, color: Palette.secondaryText)
                    }
                    let messages = thread?.messages ?? []
                    let tail = pinned ? min(2, messages.count) : 0
                    ForEach(messages.dropLast(tail)) { row($0) }
                    if tail > 0 {
                        VStack(alignment: .leading, spacing: Space.m) { ForEach(messages.suffix(tail)) { row($0) } }
                            .frame(minHeight: max(0, visibleHeight - Space.l), alignment: .top)
                            .id("pinned")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Space.l)
                // once the question just sent is laid out: its top to the top
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { _ in
                    guard scrollPending else { return }
                    scrollPending = false
                    withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo("pinned", anchor: .top) }
                }
            }
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        // a reader following along stays at the bottom as the answer grows or the keyboard comes and goes
        .defaultScrollAnchor(following ? .bottom : nil, for: .sizeChanges)
        // the tallest seen, so the keyboard leaving as a question is sent can't cut the room it scrolls into
        .onScrollGeometryChange(for: CGFloat.self) { $0.visibleRect.height - $0.contentInsets.top - $0.contentInsets.bottom } action: { _, height in
            visibleHeight = max(visibleHeight, height)
        }
        .onScrollGeometryChange(for: Bool.self) { $0.atBottom } action: { atBottom = $1 }
        // only the reader's own scrolling decides, not the scroll to a question just sent
        .onScrollPhaseChange { old, new, context in
            if new == .interacting { following = false }
            if new == .idle, [.interacting, .decelerating].contains(old) { following = context.geometry.atBottom }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        .safeAreaInset(edge: .top) {
            if backupActive { Text("Using backup key").textStyle(.caption, color: Palette.secondaryText) }
        }
        .overlay(alignment: .bottom) {
            ZStack {
                if !atBottom {
                    Button("Scroll to bottom", systemImage: "arrow.down") {
                        following = true
                        withAnimation(reduceMotion ? nil : .default) { position.scrollTo(edge: .bottom) }
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .controlSize(.large)
                    .tint(Palette.surface)
                    .foregroundStyle(Palette.text)
                    .padding(.bottom, Space.s)
                }
            }
            .animation(reduceMotion ? nil : .default, value: atBottom)
        }
        // a bar, not an inset: it fades the answers scrolling under it, as the tab bar does
        .safeAreaBar(edge: .bottom) { input }
        .task(id: typed == nil) {
            var last = ContinuousClock.now
            while typed != nil {
                try? await Task.sleep(for: .milliseconds(33))
                // a cancelled pass (Reduce Motion or VoiceOver turned on) mustn't start typing again
                guard !Task.isCancelled, let shown = typed else { return }
                let now = ContinuousClock.now
                let ended = thread?.isStreaming != true, text = thread?.messages.last?.text ?? ""
                let next = TypingPace.next(text: text, shown: shown, elapsed: (now - last) / .seconds(1), ended: ended)
                last = now
                if ended && next == text.count {
                    typed = nil
                } else if next != shown {
                    typed = next
                } else {
                    // nothing new to show (thinking, a tool, or caught up): look again in about 100 ms
                    try? await Task.sleep(for: .milliseconds(67))
                }
            }
        }
        .onChange(of: reduceMotion || voiceOver) { _, plain in if plain { typed = nil } }
        .refreshable { await load() }
        .navigationTitle(title.isEmpty ? "New chat" : title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(covered ? .hidden : .automatic, for: .navigationBar)
        .task { await load() }
        .task { await loadUsage() }
        // an answer still being written by an earlier visit: look again until it ends
        .task(id: thread?.isStreaming == true && stream == nil) {
            while thread?.isStreaming == true, stream == nil, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await load()
            }
        }
    }

    private var input: some View {
        let streaming = thread?.isStreaming == true
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(alignment: .bottom, spacing: Space.s) {
            TextField("Ask about your money", text: $draft, axis: .vertical).lineLimit(1...5).textStyle(.body)
            Button(streaming ? "Stop" : "Send", systemImage: streaming ? "stop.circle.fill" : "arrow.up.circle.fill") {
                if !streaming {
                    send(text)
                } else if thread?.acceptsStop(sentAt: sentAt, now: .now) == true {
                    stop()
                }
            }
            .labelStyle(.iconOnly)
            .font(TextStyle.title.font)
            .disabled(thread == nil || (!streaming && (stream != nil || text.isEmpty || text.utf16.count > 4000)))
        }
        .padding(Space.m)
        .glassEffect(.regular.tint(Palette.surface), in: .rect(cornerRadius: Radius.medium))
        // floats like the tab bar below it, with even space above and below; sides line up with the answers
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
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
            let lastQuestion = { (messages: [ChatMessage]) in messages.last { $0.role == "user" }?.text }
            guard stream == nil, !resync || detail.messages.count > thread?.messages.count ?? 0
                    || lastQuestion(detail.messages) == lastQuestion(thread?.messages ?? []) else { return }
            thread = ChatThread(detail)
            title = detail.title
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = errorMessage(error)
        }
    }

    @ViewBuilder
    private func row(_ message: ChatMessage) -> some View {
        if message.role == "user" {
            UserBubble(message: message).equatable()
        } else {
            AnswerRow(message: message, typed: message.id == thread?.messages.last?.id ? typed : nil, canRetry: stream == nil, onRetry: retry)
                .equatable()
        }
    }

    private func send(_ text: String) {
        draft = ""
        // setting a FocusState left the keyboard up in the simulator; this is what AskLock does too
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
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
        // a stopped first answer leaves the chat to be named after the next done one
        let firstAnswer = !(thread?.messages.contains { $0.role == "assistant" && $0.status == "done" } ?? false)
        thread?.send(text: text, clientId: clientId, now: Date().ISO8601Format())
        sentAt = .now
        typed = reduceMotion || voiceOver ? nil : 0
        pinned = true
        following = false
        scrollPending = true
        stream = Task {
            var created: String?
            do {
                if chatId == nil {
                    created = try await client.createChat(idempotencyKey: createKey).id
                    chatId = created
                }
                // the chat can still be busy for a moment after a Stop
                for attempt in 1...2 {
                    do {
                        try await ChatStream.send(client: client, chatId: chatId ?? "", clientId: clientId, text: text) { thread?.apply($0) }
                        break
                    } catch ClientError.api(_, let body) where body.code == "CHAT_BUSY" && attempt == 1 {
                        try await Task.sleep(for: .seconds(1))
                    }
                }
            } catch ClientError.api(_, let body) {
                thread?.fail(code: body.code)
                // a chat whose first question was turned away would sit empty in the list
                if let created, (try? await client.deleteChat(id: created)) != nil {
                    chatId = nil
                    createKey = UUID().uuidString
                }
            } catch {
                thread?.fail(code: "NETWORK")
            }
            // ended without done or error; a no-op once the answer has an outcome
            thread?.fail(code: "INTERRUPTED")
            stream = nil
            // the server may have saved a different outcome (done, stopped) than the connection showed
            if ["NETWORK", "INTERRUPTED"].contains(thread?.messages.last?.errorCode) { await load(resync: true) }
            refreshTitle(client: client, firstAnswer: firstAnswer)
            await loadUsage()
        }
    }

    /// The server names a chat a moment after its first done answer; Haiku can take longer than the first look.
    private func refreshTitle(client: APIClient, firstAnswer: Bool) {
        guard firstAnswer, thread?.messages.last?.status == "done", let chatId,
              let question = thread?.messages.first(where: { $0.role == "user" })?.text else { return }
        // the server's title from the first question: trimmed, first 60 UTF-16 units (JavaScript's slice)
        let auto = String(decoding: question.trimmingCharacters(in: .whitespacesAndNewlines).utf16.prefix(60), as: UTF16.self)
        Task {
            for wait in [3, 5] {
                try? await Task.sleep(for: .seconds(wait))
                guard let detail = try? await client.chat(id: chatId) else { continue }
                title = detail.title
                if detail.title != auto { return }
            }
        }
    }

    /// Leaving the screen doesn't stop an answer; only this does. It also stops one left running by an earlier visit.
    private func stop() {
        thread?.stop()
        Task {
            if let chatId { try? await model.client?.stopChat(id: chatId) }
            stream?.cancel()
            await stream?.value
            // the server's copy: the saved stopped answer, or one still running if the stop didn't get through
            await load()
        }
    }

    private func loadUsage() async { backupActive = (try? await model.client?.aiUsage())?.backupActive ?? backupActive }
}

extension ScrollGeometry {
    /// `visibleRect` includes the insets under the bars.
    fileprivate var atBottom: Bool { contentSize.height + contentInsets.bottom - visibleRect.maxY < Space.xl }
}

private struct UserBubble: View, Equatable {
    let message: ChatMessage

    var body: some View {
        HStack {
            Spacer(minLength: Space.xxl)
            Text(message.text).textStyle(.body, color: Palette.onAccent).textSelection(.enabled)
                .padding(Space.m)
                .background(Palette.accent, in: RoundedRectangle(cornerRadius: Radius.medium))
        }
    }
}

/// Equatable so a streaming answer doesn't re-parse every earlier row's Markdown.
private struct AnswerRow: View, Equatable {
    let message: ChatMessage
    /// Characters typed out so far; the answer counts as streaming until it all shows, so Stopped or an error waits for the text.
    let typed: Int?
    let canRetry: Bool
    let onRetry: () -> Void

    nonisolated static func == (a: Self, b: Self) -> Bool { a.message == b.message && a.typed == b.typed && a.canRetry == b.canRetry }

    var body: some View {
        let text = typed.map { String(message.text.prefix($0)) } ?? message.text
        let status = typed == nil ? message.status : "streaming"
        let waiting = status == "streaming" && text.isEmpty
        // a chart draws itself, so the status names the last tool that isn't one
        let looking = message.tools.lastIndex { ChatChart($0) == nil }
        VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(Array(message.tools.enumerated()), id: \.offset) { index, tool in
                if let chart = ChatChart(tool) {
                    ChatChartCard(chart: chart)
                } else if !waiting || index != looking {
                    Text("Looked at " + (tool.label ?? tool.name)).textStyle(.caption, color: Palette.secondaryText)
                }
            }
            if !text.isEmpty {
                VStack(alignment: .leading, spacing: Space.s) {
                    ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in Block(block: block) }
                }
                .textSelection(.enabled)
            }
            switch status {
            case "streaming" where text.isEmpty:
                Shimmer(text: looking.map { "Looking at " + (message.tools[$0].label ?? message.tools[$0].name) } ?? "Thinking…")
            case "stopped": Text("Stopped").textStyle(.caption, color: Palette.secondaryText)
            case "failed": failure
            default: EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            if !message.text.isEmpty { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text } }
        }
    }

    @ViewBuilder
    private var failure: some View {
        let final = ["AI_CREDITS_EXHAUSTED": "AI credits used up for this month", "AI_NOT_CONFIGURED": "AI isn't set up on the server",
                     "CHAT_TOO_LONG": "This chat is too long. Start a new one."]
        let retryable = ["MAX_TOKENS": "The answer got too long. Ask for less.", "REFUSED": "Claude couldn't answer that."]
        if let text = final[message.errorCode ?? ""] {
            Text(text).textStyle(.caption, color: Palette.loss)
        } else {
            Button("\(retryable[message.errorCode ?? ""] ?? "Couldn't answer") · Retry", action: onRetry)
                .textStyle(.caption, color: Palette.loss).disabled(!canRetry)
        }
    }
}

/// What the answer is doing before its text starts, with a light sweeping across it (static under Reduce Motion).
/// Caption, like the "Looked at" lines it turns into, so nothing jumps; VoiceOver hears each change.
private struct Shimmer: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let label = Text(text).textStyle(.caption, color: Palette.secondaryText)
        Group {
            if reduceMotion {
                label
            } else {
                label.overlay {
                    TimelineView(.animation) { context in
                        let x = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) - 0.3
                        LinearGradient(colors: [.clear, Palette.text, .clear],
                                       startPoint: UnitPoint(x: x - 0.3, y: 0.5), endPoint: UnitPoint(x: x + 0.3, y: 0.5))
                    }
                    .mask(label)
                    .accessibilityHidden(true)
                }
            }
        }
        .onChange(of: text) { _, now in AccessibilityNotification.Announcement(now).post() }
    }
}

private struct Block: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .paragraph(let text): Text(text).textStyle(.body)
        case .heading(let text): Text(text).textStyle(.headline)
        case .listItem(let marker, let depth, let text, let continued):
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                // hidden, not left out, so a later paragraph lines up with the item's first
                Text(marker).textStyle(.body).monospacedDigit().opacity(continued ? 0 : 1).accessibilityHidden(continued)
                Text(text).textStyle(.body)
            }
            .padding(.leading, CGFloat(depth) * Space.l)
        case .code(let code): Text(code).font(TextStyle.subhead.font.monospaced()).foregroundStyle(Palette.text)
        case .table(let rows):
            Grid(alignment: .leading, horizontalSpacing: Space.m, verticalSpacing: Space.xs) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(cell).textStyle(index == 0 ? .subhead : .body, color: index == 0 ? Palette.secondaryText : Palette.text)
                        }
                    }
                    if index == 0 { Divider().overlay(Palette.separator) }
                }
            }
        }
    }
}
