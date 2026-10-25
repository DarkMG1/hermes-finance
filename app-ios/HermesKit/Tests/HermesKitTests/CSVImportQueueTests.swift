import Foundation
import Testing
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
