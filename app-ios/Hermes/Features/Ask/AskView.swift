import HermesKit
import SwiftUI

/// Saved chats, newest first. A new chat is created on its first question, so an abandoned compose leaves nothing behind.
struct AskView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.askProfileUnlocked) private var profileUnlocked
    @State private var chats: [ChatSummary]?
    @State private var error: String?
    @State private var outdated = false
    @State private var composing = false
    /// a question handed over from elsewhere (Tax's ways to save) for the new chat
    @State private var composeDraft = ""
    /// bumped to open a fresh new chat
    @State private var newChat = 0
    /// a question handed to a new chat already open with text typed: it's added below that text
    @State private var handoff: String?
    @State private var composeHasText = false
    @State private var renaming: ChatSummary?
    @State private var newTitle = ""
    @State private var path: [ChatSummary] = []

    var body: some View {
        NavigationStack(path: $path) { list }
    }

    private var list: some View {
        List {
            if outdated {
                Text("Update the server to use Ask").textStyle(.subhead, color: Palette.secondaryText)
            } else {
                InlineError(message: error)
                ForEach(chats ?? []) { chat in
                    NavigationLink(value: chat) {
                        ListRow(title: chat.title.isEmpty ? "New chat" : chat.title, subtitle: relative(chat.updatedAt))
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) { Task { await delete(chat) } }
                        Button("Rename") {
                            newTitle = chat.title
                            renaming = chat
                        }
                    }
                }
                if chats?.isEmpty == true {
                    Text("Ask about your spending, bills, IOUs or investments").textStyle(.subhead, color: Palette.secondaryText)
                }
            }
        }
        .themedForm()
        .navigationTitle("Ask")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New chat", systemImage: "square.and.pencil") {
                    composeDraft = ""
                    newChat += 1
                    composing = true
                }.disabled(outdated)
            }
        }
        .navigationDestination(for: ChatSummary.self) { ConversationView(chatId: $0.id, title: $0.title) }
        .navigationDestination(isPresented: $composing) {
            ConversationView(chatId: nil, draft: composeDraft, handoff: $handoff, hasText: $composeHasText).id(newChat)
        }
        .onChange(of: model.askDraft, initial: true) { _, draft in
            guard let draft else { return }
            // cleared after this update, so the profile gate and the tab bar see it too
            Task { @MainActor in model.askDraft = nil }
            // a saved chat open goes back to the list first
            path = []
            // text the owner typed in an open new chat stays; otherwise a fresh chat starts with the question
            if composing && composeHasText { handoff = draft; return }
            composeDraft = draft
            newChat += 1
            composing = true
        }
        .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Save") { if let chat = renaming { Task { await rename(chat) } } }
                .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancel", role: .cancel) {}
        }
        .refreshable { await load() }
        .task { await load() }
        // titles written after a chat got profile data show only while it's unlocked
        .onChange(of: profileUnlocked.wrappedValue) { Task { await load() } }
    }

    private func relative(_ iso: String) -> String? {
        (try? Date(iso, strategy: .iso8601))?.formatted(.relative(presentation: .named))
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            chats = try await client.chats(profileUnlocked: profileUnlocked.wrappedValue).chats
            error = nil
            outdated = false
        } catch ClientError.api(404, _) {
            outdated = true
        } catch {
            guard !Task.isCancelled else { return }
            self.error = errorMessage(error)
        }
    }

    private func rename(_ chat: ChatSummary) async {
        do {
            try await model.client?.renameChat(id: chat.id, title: String(newTitle.trimmingCharacters(in: .whitespaces).prefix(60)))
            await load()
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func delete(_ chat: ChatSummary) async {
        do {
            try await model.client?.deleteChat(id: chat.id)
            await load()
        } catch ClientError.api(409, let body) where body.code == "CHAT_BUSY" {
            self.error = "Wait for the answer to finish"
        } catch {
            self.error = errorMessage(error)
        }
    }
}
