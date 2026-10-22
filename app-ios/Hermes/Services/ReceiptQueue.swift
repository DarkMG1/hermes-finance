import HermesKit
import SwiftUI
import UIKit

/// Snapped receipts wait here as files until the server has them, so a weak signal at the register loses nothing.
@MainActor @Observable
final class ReceiptQueue {
    var pending: [String] { store.pending }
    var uploading: Set<String> { store.uploading }
    private(set) var error: String?
    private var store: ReceiptQueueStore = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return ReceiptQueueStore(directory: base.appending(path: "ReceiptQueue", directoryHint: .isDirectory))
    }()

    func selectServer(_ server: URL?) {
        error = nil
        do {
            try store.selectServer(server)
        } catch {
            self.error = "Couldn't open the saved receipt photos."
        }
    }

    func add(_ image: UIImage, scan: Bool = false, client: APIClient?) async {
        guard let client else { return }
        guard let jpeg = ReceiptImage.jpeg(image, scan: scan) else { error = "Couldn't read that photo."; return }
        let id = UUID().uuidString.lowercased()
        do {
            try store.add(jpeg, id: id, server: client.baseURL)
        } catch {
            self.error = "Couldn't save the photo on this iPhone."
            return
        }
        // a good signal now is the moment to send the ones that failed earlier
        let generation = store.generation
        if await upload(id, client: client), generation == store.generation { await retryAll(client: client) }
    }

    func retryAll(client: APIClient?) async {
        do { try store.reload() } catch { self.error = "Couldn't open the saved receipt photos." }
        let generation = store.generation
        for id in pending {
            guard generation == store.generation, !Task.isCancelled else { return }
            await upload(id, client: client)
        }
    }

    func delete(_ id: String) {
        do { try store.delete(id) } catch { self.error = "Couldn't delete that photo." }
    }

    func photo(_ id: String) -> UIImage? { store.file(id).flatMap { UIImage(contentsOfFile: $0.path()) } }

    /// Keep the local photo until this connection's upload succeeds.
    @discardableResult
    private func upload(_ id: String, client: APIClient?) async -> Bool {
        guard let client, store.isForServer(client.baseURL), let upload = store.beginUpload(id) else { return false }
        defer { store.endUpload(upload) }
        guard let jpeg = try? Data(contentsOf: upload.file) else { return false }
        do {
            try await client.uploadInboxReceipt(id: id, jpeg: jpeg, capturedAt: upload.file.creationDate ?? .now)
            guard store.isCurrent(upload) else { return false }
            try store.completeUpload(upload)
            error = nil
            return true
        } catch {
            guard store.isCurrent(upload) else { return false }
            self.error = "Some receipts are waiting to upload. They'll retry when Hermes is back in the foreground."
            return false
        }
    }
}

private extension URL {
    var creationDate: Date? { (try? resourceValues(forKeys: [.creationDateKey]))?.creationDate }
}
