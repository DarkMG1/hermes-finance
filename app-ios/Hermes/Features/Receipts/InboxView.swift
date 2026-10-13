import HermesKit
import SwiftUI

/// Receipts waiting for their bank charge, plus snaps still waiting to upload.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(ReceiptQueue.self) private var queue
    @State private var list: InboxList?
    @State private var error: String?
    @State private var deleting: InboxReceipt?
    @State private var deletingUpload: String?
    @State private var snapping = false
    @State private var itemizing: LedgerTransaction?

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
                        .swipeActions { Button("Delete", role: .destructive) { deletingUpload = id } }
                        .confirmationDialog("Delete this receipt?", isPresented: Binding(get: { deletingUpload == id },
                                                                                          set: { if !$0 { deletingUpload = nil } }),
                                            titleVisibility: .visible) {
                            Button("Delete", role: .destructive) { queue.delete(id) }
                        }
                    }
                }
            }
            if let linked = list?.recentlyLinked.prefix(3), !linked.isEmpty {
                Section("Recently linked") {
                    ForEach(linked) { linked in
                        HStack {
                            Button { Task { await open(linked) } } label: {
                                ListRow(title: linked.merchant ?? "Receipt", subtitle: linked.splitApplied ? "Linked · split applied" : "Linked · Itemize") {
                                    if let total = linked.totalCents { MoneyText(cents: total, colored: false) }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Button("Dismiss", systemImage: "xmark") { Task { await dismiss(linked) } }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.borderless)
                        }
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
                    .confirmationDialog("Delete this receipt?", isPresented: Binding(get: { deleting?.id == receipt.id },
                                                                                      set: { if !$0 { deleting = nil } }),
                                        titleVisibility: .visible) {
                        Button("Delete", role: .destructive) { Task { await delete(receipt) } }
                    }
                }
                if list?.waiting.isEmpty == true && queue.pending.isEmpty {
                    Text("Nothing waiting. Tap the camera to snap a receipt.").textStyle(.subhead, color: Palette.secondaryText)
                }
            }
        }
        .themedForm()
        .navigationTitle("Receipt inbox")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { snapping = true } label: { Image(systemName: "camera") }
                    .accessibilityLabel("Snap receipt")
            }
        }
        .receiptCamera(isPresented: $snapping)
        .sheet(item: $itemizing) { transaction in
            ItemizeView(transaction: transaction) { await load() }
        }
        .refreshable { await queue.retryAll(client: model.client); await load() }
        .task { await load() }
        // while anything is being read, look again every few seconds
        .task(id: list?.waiting.contains { $0.status == "reading" } == true) {
            while list?.waiting.contains(where: { $0.status == "reading" }) == true, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                await load()
            }
        }
        .onChange(of: queue.pending.count) { Task { await load() } }
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

    private func open(_ linked: LinkedReceipt) async {
        guard let reader = model.reader else { return }
        do {
            itemizing = try await reader.read("/v1/transactions/\(linked.transactionId)", as: LedgerTransaction.self).value
            await dismiss(linked)
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func dismiss(_ linked: LinkedReceipt) async {
        try? await model.client?.dismissInboxReceipt(id: linked.id)
        await load()
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
