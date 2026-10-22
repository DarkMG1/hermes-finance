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

@Test func onlyRestoringAKnownConnectionAdoptsLegacyPhotos() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let oldFile = root.appending(path: "legacy.jpg")
    try Data([8]).write(to: oldFile)
    var queue = ReceiptQueueStore(directory: root)
    try queue.selectServer(testBase)
    #expect(queue.pending.isEmpty && FileManager.default.fileExists(atPath: oldFile.path))
    try queue.selectServer(testBase, migratingLegacy: true)
    #expect(queue.pending == ["legacy"] && !FileManager.default.fileExists(atPath: oldFile.path))
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
