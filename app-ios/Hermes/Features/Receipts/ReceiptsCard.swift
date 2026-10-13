import HermesKit
import PhotosUI
import SwiftUI

/// Home's receipts: snap one now, see how many wait for their bank charge, and jump into the ones that just linked.
struct ReceiptsCard: View {
    @Environment(AppModel.self) private var model
    @Environment(ReceiptQueue.self) private var queue
    let refreshToken: Int

    @State private var list: InboxList?
    @State private var error: String?
    @State private var takingPhoto = false
    @State private var choosingPhoto = false
    @State private var pickerItem: PhotosPickerItem?
    @State private var itemizing: LedgerTransaction?
    @State private var handledSnaps = 0
    private var snap: QuickActions { QuickActions.shared }

    var body: some View {
        Card {
            HStack {
                NavigationLink { InboxView() } label: {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("Receipts").textStyle(.subhead, color: Palette.secondaryText)
                        Text(summary).textStyle(.body)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button { snapPhoto() } label: { Image(systemName: "camera").font(.title3) }
                    .accessibilityLabel("Snap receipt")
            }
            ForEach(list?.recentlyLinked.prefix(3) ?? []) { linked in
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
                }
            }
            InlineError(message: error ?? queue.error)
        }
        .task(id: refreshToken) { await load(); await queue.retryAll(client: model.client) }
        .onChange(of: queue.pending.count) { Task { await load() } }
        .onChange(of: snap.snapRequests, initial: true) { _, requests in
            guard requests > handledSnaps, model.client != nil else { return }
            handledSnaps = requests
            snapPhoto()
        }
        .photosPicker(isPresented: $choosingPhoto, selection: $pickerItem, matching: .images)
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            pickerItem = nil
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self), let picked = UIImage(data: data) else {
                    error = "Couldn't read that photo."
                    return
                }
                await queue.add(picked, client: model.client)
            }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { photo in
                takingPhoto = false
                guard let photo else { return }
                Task { await queue.add(photo, client: model.client) }
            }
            .ignoresSafeArea()
        }
        .sheet(item: $itemizing) { transaction in
            ItemizeView(transaction: transaction) { await load() }
        }
    }

    private func snapPhoto() {
        if UIImagePickerController.isSourceTypeAvailable(.camera) { takingPhoto = true } else { choosingPhoto = true }
    }

    private var summary: String {
        let waiting = (list?.waiting.count ?? 0) + queue.pending.count
        return waiting == 0 ? "Nothing waiting" : waiting == 1 ? "1 waiting for its charge" : "\(waiting) waiting for their charges"
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
}
