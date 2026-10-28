import Foundation
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

/// Keep duplicate deliveries together until the current import finishes.
public struct CSVImportQueue: Sendable {
    public private(set) var files: [URL] = []
    public private(set) var busy = false
    private var completed: Set<URL> = []

    public init() {}

    public static func read(_ url: URL) throws -> String {
        let maxBytes = 5 * 1024 * 1024
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        guard try file.seekToEnd() <= UInt64(maxBytes) else { throw CocoaError(.fileReadTooLarge) }
        try file.seek(toOffset: 0)
        let data = try file.read(upToCount: maxBytes + 1) ?? Data()
        guard data.count <= maxBytes else { throw CocoaError(.fileReadTooLarge) }
        guard let csv = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
        return csv
    }

    public mutating func add(_ url: URL, fileExists: Bool = true) {
        guard !files.contains(url), fileExists || !completed.contains(url) else { return }
        completed.remove(url)
        files.append(url)
    }

    public mutating func begin(ready: Bool) -> URL? {
        guard ready, !busy, let url = files.first else { return nil }
        busy = true
        return url
    }

    public mutating func finish() {
        guard busy else { return }
        completed.insert(files.removeFirst())
        busy = false
    }

    // UTType is Apple-only; HermesKit also builds on Linux CI
    #if canImport(UniformTypeIdentifiers)
    public static func accepts(_ url: URL, contentType: UTType?) -> Bool {
        url.isFileURL && (contentType?.conforms(to: .commaSeparatedText) == true || url.pathExtension.lowercased() == "csv")
    }
    #endif

    public func staleInboxCopies(_ urls: [URL], documents: URL) -> [URL] {
        guard files.isEmpty else { return [] }
        return urls.filter { Self.isInboxCopy($0, documents: documents) }
    }

    public static func isInboxCopy(_ url: URL, documents: URL) -> Bool {
        let inbox = documents.resolvingSymlinksInPath().appending(path: "Inbox").pathComponents
        return url.isFileURL && url.deletingLastPathComponent().resolvingSymlinksInPath().pathComponents == inbox
    }
}
