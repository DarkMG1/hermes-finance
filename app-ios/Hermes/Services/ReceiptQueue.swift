import HermesKit
import SwiftUI
import UIKit

/// Snapped receipts wait here as files until the server has them, so a weak signal at the register loses nothing.
@MainActor @Observable
final class ReceiptQueue {
    private(set) var pending: [String] = []
    private(set) var error: String?

    private let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appending(path: "ReceiptQueue", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.complete])
        return dir
    }()

    init() { pending = Self.ids(in: dir) }

    private static func ids(in dir: URL) -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey])) ?? []
        return files.filter { $0.pathExtension == "jpg" }
            .sorted { ($0.creationDate ?? .distantPast) > ($1.creationDate ?? .distantPast) }
            .map { $0.deletingPathExtension().lastPathComponent }
    }

    private func file(_ id: String) -> URL { dir.appending(path: "\(id).jpg") }

    func add(_ image: UIImage, scan: Bool = false, client: APIClient?) async {
        guard let jpeg = ReceiptImage.jpeg(image, scan: scan) else { error = "Couldn't read that photo."; return }
        let id = UUID().uuidString.lowercased()
        do {
            try jpeg.write(to: file(id), options: [.atomic, .completeFileProtection])
        } catch {
            self.error = "Couldn't save the photo on this iPhone."
            return
        }
        pending.insert(id, at: 0)
        // a good signal now is the moment to send the ones that failed earlier
        if await upload(id, client: client) { await retryAll(client: client) }
    }

    func retryAll(client: APIClient?) async {
        for id in pending { await upload(id, client: client) }
    }

    func delete(_ id: String) {
        try? FileManager.default.removeItem(at: file(id))
        pending.removeAll { $0 == id }
    }

    func photo(_ id: String) -> UIImage? { UIImage(contentsOfFile: file(id).path()) }

    /// The server's PUT is idempotent by id, so overlapping retries are harmless.
    @discardableResult
    private func upload(_ id: String, client: APIClient?) async -> Bool {
        guard let client, let jpeg = try? Data(contentsOf: file(id)) else { return false }
        do {
            try await client.uploadInboxReceipt(id: id, jpeg: jpeg, capturedAt: file(id).creationDate ?? .now)
            delete(id)
            error = nil
            return true
        } catch {
            self.error = "Some receipts are waiting to upload. They'll retry when Hermes is back in the foreground."
            return false
        }
    }
}

private extension URL {
    var creationDate: Date? { (try? resourceValues(forKeys: [.creationDateKey]))?.creationDate }
}
