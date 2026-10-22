import CryptoKit
import Foundation

/// Files survive disconnects, but only the current server's photos are visible or eligible for upload.
public struct ReceiptQueueStore: Sendable {
    public struct Upload: Sendable {
        public let id: String
        public let file: URL
        fileprivate let generation: Int
    }

    public private(set) var serverURL: URL?
    public private(set) var pending: [String] = []
    public var uploading: Set<String> { Set(pending.filter { id in file(id).map { activeUploads.contains($0) } ?? false }) }
    public private(set) var generation = 0
    private let root: URL
    private var directory: URL?
    private var activeUploads: Set<URL> = []

    public init(directory: URL) { root = directory }

    public mutating func selectServer(_ server: URL?, migratingLegacy: Bool = true) throws {
        generation += 1
        serverURL = server?.receiptServerURL
        pending = []
        directory = nil
        guard let server = serverURL else { return }
        let key = SHA256.hash(data: Data(server.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        let directory = root.appending(path: key, directoryHint: .isDirectory)
        #if os(iOS)
        let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]
        #else
        let attributes: [FileAttributeKey: Any] = [:]
        #endif
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
        self.directory = directory
        try reload(migratingLegacy: migratingLegacy)
    }

    public func isForServer(_ server: URL) -> Bool { server.receiptServerURL == serverURL }

    public mutating func reload(migratingLegacy: Bool = true) throws {
        guard let directory else { return }
        var migrationError: Error?
        if migratingLegacy {
            do {
                for file in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) where file.pathExtension == "jpg" {
                    do {
                        try FileManager.default.moveItem(at: file, to: directory.appending(path: file.lastPathComponent))
                    } catch { migrationError = error }
                }
            } catch {
                migrationError = error
            }
        }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.creationDateKey])
        pending = files.filter { $0.pathExtension == "jpg" }
            .sorted { $0.receiptCreationDate > $1.receiptCreationDate }
            .map { $0.deletingPathExtension().lastPathComponent }
        if let migrationError { throw migrationError }
    }

    public func file(_ id: String) -> URL? { directory?.appending(path: "\(id).jpg") }

    public mutating func add(_ jpeg: Data, id: String, server: URL? = nil) throws {
        if let server, !isForServer(server) {
            var original = ReceiptQueueStore(directory: root)
            try original.selectServer(server, migratingLegacy: false)
            try original.add(jpeg, id: id)
            return
        }
        guard let file = file(id) else { throw CocoaError(.fileNoSuchFile) }
        #if os(iOS)
        try jpeg.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try jpeg.write(to: file, options: .atomic)
        #endif
        pending.insert(id, at: 0)
    }

    public mutating func delete(_ id: String) throws {
        guard !uploading.contains(id), let file = file(id) else { return }
        try FileManager.default.removeItem(at: file)
        pending.removeAll { $0 == id }
    }

    public mutating func beginUpload(_ id: String) -> Upload? {
        guard pending.contains(id), let file = file(id), !activeUploads.contains(file) else { return nil }
        activeUploads.insert(file)
        return Upload(id: id, file: file, generation: generation)
    }

    public func isCurrent(_ upload: Upload) -> Bool { upload.generation == generation }

    public mutating func endUpload(_ upload: Upload) {
        activeUploads.remove(upload.file)
    }

    public mutating func completeUpload(_ upload: Upload) throws {
        guard isCurrent(upload) else { return }
        try FileManager.default.removeItem(at: upload.file)
        pending.removeAll { $0 == upload.id }
    }
}

private extension URL {
    var receiptServerURL: URL {
        guard var components = URLComponents(url: self, resolvingAgainstBaseURL: true) else { return self }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        while components.percentEncodedPath.hasSuffix("/") { components.percentEncodedPath.removeLast() }
        return components.url ?? self
    }

    var receiptCreationDate: Date { (try? resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast }
}
