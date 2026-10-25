import Foundation
import Testing
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif
@testable import HermesKit

@Test func csvImportWaitsUntilTheAppIsReady() {
    var queue = CSVImportQueue()
    let file = URL(fileURLWithPath: "/synthetic/Synthetic Quill.csv")
    queue.add(file)
    let held = queue.begin(ready: false)
    #expect(held == nil && queue.files == [file] && !queue.busy)
    let opened = queue.begin(ready: true)
    #expect(opened == file && queue.busy)
    queue.finish()
    let empty = queue.begin(ready: true)
    #expect(empty == nil && queue.files.isEmpty && !queue.busy)
}

@Test func duplicateCSVsCannotStartTwoImports() {
    var queue = CSVImportQueue()
    let file = URL(fileURLWithPath: "/synthetic/Synthetic Quill.csv")
    queue.add(file)
    queue.add(file)
    let first = queue.begin(ready: true)
    queue.add(file)
    let second = queue.begin(ready: true)
    #expect(first == file && second == nil && queue.files == [file])
    queue.finish()
    #expect(queue.files.isEmpty)
}

@Test func distinctCSVsWaitTheirTurnAndRecheckReadiness() {
    var queue = CSVImportQueue()
    let first = URL(fileURLWithPath: "/synthetic/Synthetic Quill.csv")
    let second = URL(fileURLWithPath: "/synthetic/Synthetic Wren.csv")
    queue.add(first)
    let opened = queue.begin(ready: true)
    queue.add(second)
    queue.finish()
    let held = queue.begin(ready: false)
    #expect(opened == first && held == nil && queue.files == [second])
    let next = queue.begin(ready: true)
    #expect(next == second)
    queue.finish()
    // Choosing the same file again is an intentional retry, with the existing WriteGuard key.
    queue.add(first)
    let retry = queue.begin(ready: true)
    #expect(retry == first)
}

@Test func lateDuplicateDeliveriesAreIgnoredButAFreshCopyCanRetry() {
    var queue = CSVImportQueue()
    let file = URL(fileURLWithPath: "/synthetic/Synthetic Quill.csv")
    queue.add(file)
    _ = queue.begin(ready: true)
    queue.finish()
    queue.add(file, fileExists: false)
    let duplicate = queue.begin(ready: true)
    #expect(duplicate == nil && queue.files.isEmpty)
    queue.add(file, fileExists: true)
    let retry = queue.begin(ready: true)
    #expect(retry == file)

    var missing = CSVImportQueue()
    missing.add(file, fileExists: false)
    let firstDelivery = missing.begin(ready: true)
    #expect(firstDelivery == file) // the first missing file must report its read error
}

@Test func onlyTheAppsInboxCopiesCanBeDeleted() {
    let documents = URL(fileURLWithPath: "/synthetic/Documents", isDirectory: true)
    let inbox = documents.appending(path: "Inbox", directoryHint: .isDirectory)
    #expect(CSVImportQueue.isInboxCopy(inbox.appending(path: "Synthetic Quill.csv"), documents: documents))
    #expect(!CSVImportQueue.isInboxCopy(documents.appending(path: "Synthetic Quill.csv"), documents: documents))
    #expect(!CSVImportQueue.isInboxCopy(URL(fileURLWithPath: "/synthetic/Other/Inbox/Synthetic Quill.csv"), documents: documents))
    #expect(!CSVImportQueue.isInboxCopy(inbox.appending(path: "Nested/Synthetic Quill.csv"), documents: documents))
    #expect(!CSVImportQueue.isInboxCopy(URL(string: "https://synthetic.example/Documents/Inbox/Synthetic.csv")!, documents: documents))
}

#if canImport(UniformTypeIdentifiers)
@Test func csvImportsAcceptTheSystemTypeOrFilenameExtension() throws {
    let typed = URL(fileURLWithPath: "/synthetic/Synthetic Quill")
    let csvSubtype = try #require(UTType(filenameExtension: "syntheticcsv", conformingTo: .commaSeparatedText))
    #expect(CSVImportQueue.accepts(typed, contentType: .commaSeparatedText))
    #expect(CSVImportQueue.accepts(typed, contentType: csvSubtype))
    #expect(CSVImportQueue.accepts(typed.appendingPathExtension("txt"), contentType: .commaSeparatedText))
    #expect(CSVImportQueue.accepts(typed.appendingPathExtension("CSV"), contentType: .plainText))
    #expect(CSVImportQueue.accepts(typed.appendingPathExtension("csv"), contentType: nil))
    #expect(!CSVImportQueue.accepts(typed, contentType: .plainText))
    #expect(!CSVImportQueue.accepts(typed.appendingPathExtension("txt"), contentType: nil))
    #expect(!CSVImportQueue.accepts(URL(string: "https://synthetic.example/Synthetic.csv")!, contentType: .commaSeparatedText))
}
#endif

@Test func staleInboxCopiesWaitUntilNoImportIsPending() {
    let documents = URL(fileURLWithPath: "/synthetic/Documents", isDirectory: true)
    let stale = documents.appending(path: "Inbox/Synthetic Quill.csv")
    let extensionless = documents.appending(path: "Inbox/Synthetic Wren")
    let outside = documents.appending(path: "Synthetic Moss.csv")
    let nested = documents.appending(path: "Inbox/Nested/Synthetic Fern.csv")
    let candidates = [stale, extensionless, outside, nested]
    var queue = CSVImportQueue()
    #expect(queue.staleInboxCopies(candidates, documents: documents) == [stale, extensionless])
    queue.add(outside)
    #expect(queue.staleInboxCopies(candidates, documents: documents).isEmpty)
    _ = queue.begin(ready: true)
    #expect(queue.staleInboxCopies(candidates, documents: documents).isEmpty)
    queue.finish()
    #expect(queue.staleInboxCopies(candidates, documents: documents) == [stale, extensionless])
}

@Test func anInboxSymlinkCannotExposeAnotherFolderToCleanup() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let documents = root.appending(path: "Documents")
    let outside = root.appending(path: "Other")
    try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    let inbox = documents.appending(path: "Inbox")
    try FileManager.default.createSymbolicLink(at: inbox, withDestinationURL: outside)
    let file = inbox.appending(path: "Synthetic Quill.csv")
    #expect(CSVImportQueue().staleInboxCopies([file], documents: documents).isEmpty)
}
