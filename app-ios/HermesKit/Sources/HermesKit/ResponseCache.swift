import Foundation

/// Responses kept for offline reads. `clear()` starts a new generation: a read that began before it can't write its result back.
public final class ResponseCache: @unchecked Sendable {
    private let directory: URL
    private let lock = NSLock()
    private var generation = 0
    private var requests: [String: Int] = [:]

    // unreadable while the iPhone is locked; the app never reads it in the background. iOS only: on macOS (tests, CI) the
    // write would fail whenever the screen is locked.
    #if os(iOS)
    private static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    private static var directoryAttributes: [FileAttributeKey: Any] { [.protectionKey: FileProtectionType.complete] }
    #else
    private static let writeOptions: Data.WritingOptions = [.atomic]
    private static var directoryAttributes: [FileAttributeKey: Any] { [:] }
    #endif

    public init(directory: URL) { self.directory = directory }

    private struct Entry: Codable {
        let savedAt: Date
        let body: Data
    }

    public var currentGeneration: Int { lock.withLock { generation } }

    func beginRead(key: String, generation expected: Int) -> Int? {
        lock.withLock {
            guard expected == generation else { return nil }
            requests[key, default: 0] += 1
            return requests[key]
        }
    }

    public func store(_ data: Data, key: String, savedAt: Date, generation expected: Int? = nil, request: Int? = nil) {
        lock.withLock {
            if let expected, expected != generation { return }
            if let request, request != requests[key] { return }
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: Self.directoryAttributes)
            try? JSONEncoder().encode(Entry(savedAt: savedAt, body: data)).write(to: file(for: key), options: Self.writeOptions)
        }
    }

    public func load(key: String) -> (data: Data, savedAt: Date)? {
        guard let raw = try? Data(contentsOf: file(for: key)), let entry = try? JSONDecoder().decode(Entry.self, from: raw) else { return nil }
        return (entry.body, entry.savedAt)
    }

    public func clear() {
        lock.withLock {
            generation += 1
            requests.removeAll()
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
