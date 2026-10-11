import Foundation

/// Responses kept for offline reads. `clear()` starts a new generation: a read that began before it can't write its result back.
public final class ResponseCache: @unchecked Sendable {
    private let directory: URL
    private let lock = NSLock()
    private var generation = 0

    public init(directory: URL) { self.directory = directory }

    private struct Entry: Codable {
        let savedAt: Date
        let body: Data
    }

    public var currentGeneration: Int { lock.withLock { generation } }

    public func store(_ data: Data, key: String, savedAt: Date, generation expected: Int? = nil) {
        lock.withLock {
            if let expected, expected != generation { return }
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                     attributes: [.protectionKey: FileProtectionType.complete])
            // unreadable while the iPhone is locked; the app never reads it in the background
            try? JSONEncoder().encode(Entry(savedAt: savedAt, body: data))
                .write(to: file(for: key), options: [.atomic, .completeFileProtection])
        }
    }

    public func load(key: String) -> (data: Data, savedAt: Date)? {
        guard let raw = try? Data(contentsOf: file(for: key)), let entry = try? JSONDecoder().decode(Entry.self, from: raw) else { return nil }
        return (entry.body, entry.savedAt)
    }

    public func clear() {
        lock.withLock {
            generation += 1
            try? FileManager.default.removeItem(at: directory)
        }
    }

    // FNV-1a: stable across launches and platforms, short enough for any filename limit
    private func file(for key: String) -> URL {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3 }
        return directory.appending(path: String(hash, radix: 16) + ".json")
    }
}
