import HermesKit
import SwiftUI

/// Receipts waiting for their bank charge, plus snaps still waiting to upload.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(ReceiptQueue.self) private var queue
    @State private var list: InboxList?
    @State private var error: String?
    @State private var deleting: InboxReceipt?

    var body: some View {
        List {
            InlineError(message: error ?? queue.error)
            if !queue.pending.isEmpty {
                Section("Waiting to upload") {
                    ForEach(queue.pending, id: \.self) { id in
                        HStack {
                            if let photo = queue.photo(id) {
                                Image(uiImage: photo).resizable().scaledToFill().frame(width: Space.xxl, height: Space.xxl).clipped()
                            }
                            Text("Waiting to upload").textStyle(.body)
                            Spacer()
                            Button("Retry") { Task { await queue.retryAll(client: model.client); await load() } }
                        }
                        .swipeActions { Button("Delete", role: .destructive) { queue.delete(id) } }
                    }
                }
            }
            Section {
                ForEach(list?.waiting ?? []) { receipt in
                    NavigationLink { InboxReceiptView(receipt: receipt) { await load() } } label: {
                        ListRow(title: receipt.merchant ?? "Receipt", subtitle: subtitle(receipt)) {
                            if let total = receipt.totalCents { MoneyText(cents: total, colored: false) }
                        }
                    }
                    .swipeActions { Button("Delete", role: .destructive) { deleting = receipt } }
                }
                if list?.waiting.isEmpty == true && queue.pending.isEmpty {
                    Text("Nothing waiting. Snap a receipt from Home.").textStyle(.subhead, color: Palette.secondaryText)
                }
            }
        }
        .themedForm()
        .navigationTitle("Receipt inbox")
        .refreshable { await queue.retryAll(client: model.client); await load() }
        .task { await load() }
        // while anything is being read, look again every few seconds
        .task(id: list?.waiting.contains { $0.status == "reading" } == true) {
            while list?.waiting.contains(where: { $0.status == "reading" }) == true, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                await load()
            }
        }
        .confirmationDialog("Delete this receipt?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) { if let deleting { Task { await delete(deleting) } } }
        }
    }

    private func subtitle(_ r: InboxReceipt) -> String {
        let state = switch r.status {
        case "reading": "Reading…"
        case "failed": "Couldn't read"
        default: r.suggestions.isEmpty ? (r.tagged ? "Tagged" : "Waiting for the charge")
            : r.suggestions.count == 1 ? "1 suggestion" : "\(r.suggestions.count) suggestions"
        }
        let day = r.purchaseDate.map(DayText.display) ?? DayText.display(String(r.capturedAt.prefix(10)))
        return [day, state].joined(separator: " · ")
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            list = try await client.inbox()
            error = nil
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func delete(_ r: InboxReceipt) async {
        do {
            try await model.client?.deleteInboxReceipt(id: r.id)
            await load()
        } catch {
            self.error = errorMessage(error)
        }
    }
}
