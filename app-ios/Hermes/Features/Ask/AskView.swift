import HermesKit
import SwiftUI

/// Saved chats, newest first. A new chat is created on its first question, so an abandoned compose leaves nothing behind.
struct AskView: View {
    @Environment(AppModel.self) private var model
    @State private var chats: [ChatSummary]?
    @State private var error: String?
    @State private var outdated = false
    @State private var composing = false

    var body: some View {
        List {
            if outdated {
                Text("Update the server to use Ask").textStyle(.subhead, color: Palette.secondaryText)
            } else {
                InlineError(message: error)
                ForEach(chats ?? []) { chat in
                    NavigationLink { ConversationView(chatId: chat.id) } label: {
                        ListRow(title: chat.title.isEmpty ? "New chat" : chat.title, subtitle: relative(chat.updatedAt))
                    }
                    .swipeActions { Button("Delete", role: .destructive) { Task { await delete(chat) } } }
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
                Button("New chat", systemImage: "square.and.pencil") { composing = true }.disabled(outdated)
            }
        }
        .navigationDestination(isPresented: $composing) { ConversationView(chatId: nil) }
        .refreshable { await load() }
        .task { await load() }
    }

    private func relative(_ iso: String) -> String? {
        (try? Date(iso, strategy: .iso8601))?.formatted(.relative(presentation: .named))
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            chats = try await client.chats().chats
            error = nil
            outdated = false
        } catch ClientError.api(404, _) {
            outdated = true
        } catch {
            guard !Task.isCancelled else { return }
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
