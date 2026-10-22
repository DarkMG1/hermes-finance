import Foundation
import Testing
@testable import HermesKit

@Test func queuedPhotosStayWithTheirServerAcrossDisconnects() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let first = try #require(URL(string: "https://first.example.test"))
    let second = try #require(URL(string: "https://second.example.test"))
    var queue = ReceiptQueueStore(directory: root)
    try queue.selectServer(first)
    try queue.add(Data([1, 2, 3]), id: "first-photo")
    let started = queue.beginUpload("first-photo")
    let upload = try #require(started)
    try queue.selectServer(nil)
    #expect(queue.pending.isEmpty && !queue.isCurrent(upload))
    try queue.selectServer(second)
    #expect(queue.pending.isEmpty)
    try queue.add(Data([4, 5, 6]), id: "second-photo")
    try queue.completeUpload(upload)
    #expect(queue.pending == ["second-photo"])
    try queue.selectServer(first)
    #expect(queue.pending == ["first-photo"])
    let file = try #require(queue.file("first-photo"))
    let data = try Data(contentsOf: file)
    #expect(data == Data([1, 2, 3]))
    // A restarted app restores the same queue, without exposing the other server's photo.
    var restarted = ReceiptQueueStore(directory: root)
    try restarted.selectServer(first)
    #expect(restarted.pending == ["first-photo"])
}

@Test func uploadingPhotoCannotBeDeletedOrUploadedTwice() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    var queue = ReceiptQueueStore(directory: root)
    try queue.selectServer(testBase)
    try queue.add(Data([7]), id: "photo")
    let started = queue.beginUpload("photo")
    let upload = try #require(started)
    let duplicate = queue.beginUpload("photo")
    #expect(duplicate == nil && queue.uploading.contains("photo"))
    try queue.delete("photo")
    #expect(queue.pending == ["photo"] && FileManager.default.fileExists(atPath: upload.file.path))
    try queue.selectServer(nil)
    try queue.selectServer(testBase)
    try queue.delete("photo")
    #expect(queue.uploading.contains("photo") && queue.pending == ["photo"])
    queue.endUpload(upload)
    try queue.delete("photo")
    #expect(queue.pending.isEmpty && !FileManager.default.fileExists(atPath: upload.file.path))
}

@Test func successfulUploadRemovesOnlyItsCurrentPhoto() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    var queue = ReceiptQueueStore(directory: root)
    try queue.selectServer(testBase)
    try queue.add(Data([7]), id: "photo")
    let started = queue.beginUpload("photo")
    let upload = try #require(started)
    try queue.completeUpload(upload)
    queue.endUpload(upload)
    #expect(queue.pending.isEmpty && queue.uploading.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: upload.file.path))
}

@Test func nextConnectionAdoptsUnassignedLegacyPhotosEvenAfterDisconnect() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let oldFile = root.appending(path: "legacy.jpg")
    try Data([8]).write(to: oldFile)
    var queue = ReceiptQueueStore(directory: root)
    try queue.selectServer(nil)
    #expect(queue.pending.isEmpty && FileManager.default.fileExists(atPath: oldFile.path))
    try queue.selectServer(testBase)
    #expect(queue.pending == ["legacy"] && !FileManager.default.fileExists(atPath: oldFile.path))
    let adopted = try #require(queue.file("legacy"))
    #expect(try Data(contentsOf: adopted) == Data([8]))
    try queue.selectServer(URL(string: "https://other.example.test"))
    #expect(queue.pending.isEmpty)
    try queue.selectServer(testBase)
    #expect(queue.pending == ["legacy"])
}

@Test func serverURLVariantsSharePhotosAndUploadIdentityWithoutPoolingOtherOriginsOrPaths() throws {
    for path in ["", "/ledger%2Farchive"] {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = try #require(URL(string: "https://queue.example.test:8443\(path)"))
        let variant = try #require(URL(string: "HTTPS://QUEUE.EXAMPLE.TEST:8443\(path)/"))
        var queue = ReceiptQueueStore(directory: root)
        try queue.selectServer(original)
        try queue.add(Data([1]), id: "photo")
        let file = try #require(queue.file("photo"))
        try queue.selectServer(nil)
        try queue.selectServer(variant)
        #expect(queue.pending == ["photo"] && queue.file("photo") == file)
        #expect(queue.isForServer(original) && queue.isForServer(variant))
        try queue.add(Data([2]), id: "another", server: original)
        #expect(queue.pending == ["another", "photo"])
        let started = queue.beginUpload("photo")
        let upload = try #require(started)
        #expect(upload.file == file)
        queue.endUpload(upload)
        for different in ["http://queue.example.test:8443\(path)", "https://queue.example.test:8444\(path)",
                          "https://queue.example.test:8443\(path)/other", "https://other.example.test:8443\(path)"] {
            let server = try #require(URL(string: different))
            #expect(!queue.isForServer(server))
            try queue.selectServer(server)
            #expect(queue.pending.isEmpty)
        }
    }
}

@Test func failedLegacyMoveListsMovedPhotosAndRetriesRemainingFilesOnNextAccess() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    var queue = ReceiptQueueStore(directory: root)
    try queue.selectServer(testBase)
    try queue.add(Data([1]), id: "existing")
    try queue.add(Data([2]), id: "blocked")
    let oldFile = root.appending(path: "blocked.jpg")
    try Data([3]).write(to: oldFile)
    try Data([4]).write(to: root.appending(path: "moved.jpg"))
    var failed = false
    do { try queue.selectServer(testBase) } catch { failed = true }
    #expect(failed)
    #expect(Set(queue.pending) == ["existing", "blocked", "moved"])
    let blocked = try #require(queue.file("blocked"))
    #expect(try Data(contentsOf: blocked) == Data([2]))
    #expect(try Data(contentsOf: oldFile) == Data([3]))
    let moved = try #require(queue.file("moved"))
    #expect(try Data(contentsOf: moved) == Data([4]))
    try queue.delete("blocked")
    try queue.reload()
    #expect(Set(queue.pending) == ["existing", "blocked", "moved"])
    #expect(!FileManager.default.fileExists(atPath: oldFile.path))
    #expect(try Data(contentsOf: blocked) == Data([3]))
}

@Test func photoLibraryFinishingAfterServerChangeKeepsTheOriginalDestination() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try #require(URL(string: "https://original.example.test"))
    var queue = ReceiptQueueStore(directory: root)
    try queue.selectServer(testBase)
    try queue.add(Data([9]), id: "late-photo", server: original)
    #expect(queue.pending.isEmpty)
    try queue.selectServer(original)
    #expect(queue.pending == ["late-photo"])
}
