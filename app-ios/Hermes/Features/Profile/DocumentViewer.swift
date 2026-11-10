import HermesKit
import SwiftUI

/// A kept document's pages, pinch to zoom; Re-read reads them again into the records saved from them, Delete drops the pages only.
struct DocumentViewer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let document: KeptDocument
    @State private var pages: [Int: UIImage] = [:]
    @State private var index = 0
    @State private var error: String?
    @State private var gone = false
    @State private var reading = false
    @State private var reread: ProfileReadResult?
    @State private var confirmingDelete = false
    @State private var writes = WriteGuard()

    var body: some View {
        NavigationStack {
            VStack(spacing: Space.m) {
                if let image = pages[index] {
                    ZoomView(page: index, oneFingerPan: true) { Image(uiImage: image).resizable().scaledToFit() }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Page \(index + 1) of \(document.pageCount)")
                } else {
                    Spacer()
                    if error == nil { ProgressView() }
                    Spacer()
                }
                InlineError(message: error)
                if document.pageCount > 1 {
                    HStack {
                        Button { index -= 1 } label: { Image(systemName: "chevron.left") }
                            .disabled(index == 0)
                            .accessibilityLabel("Previous page")
                        Spacer()
                        Text("Page \(index + 1) of \(document.pageCount)").textStyle(.subhead)
                        Spacer()
                        Button { index += 1 } label: { Image(systemName: "chevron.right") }
                            .disabled(index == document.pageCount - 1)
                            .accessibilityLabel("Next page")
                    }
                }
                if reading { HStack { ProgressView(); Text("Reading…").textStyle(.subhead, color: Palette.secondaryText) } }
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity)
            .background(Palette.background)
            .navigationTitle(document.kind.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Re-read") { Task { await readAgain() } }.disabled(reading || gone)
                    Spacer()
                    Button("Delete document", role: .destructive) { confirmingDelete = true }
                        .disabled(reading || gone)
                        .confirmationDialog("Delete document?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                            Button("Delete", role: .destructive) { Task { await delete() } }
                        } message: { Text("The pages are deleted. The saved numbers stay.") }
                }
            }
        }
        .interactiveDismissDisabled(reading)
        .task(id: index) { await loadPage() }
        // the review saves each draft as an update of the record it matched; closing it closes this too, so the list behind refreshes
        .sheet(isPresented: Binding(get: { reread != nil }, set: { if !$0 { reread = nil } }), onDismiss: { dismiss() }, content: {
            if let reread { ProfileCaptureFlow(reread: reread) }
        })
    }

    private func loadPage() async {
        guard pages[index] == nil, !gone, let client = model.client else { return }
        do {
            let data = try await client.documentPage(id: document.id, page: index + 1)
            if let image = UIImage(data: data) { pages[index] = image } else { error = "Couldn't show this page." }
        } catch {
            show(error)
        }
    }

    private func readAgain() async {
        guard let client = model.client else { return }
        reading = true
        error = nil
        defer { reading = false }
        do { reread = try await client.rereadDocument(id: document.id) } catch { show(error, RedactionPreview.readProblem(error)) }
    }

    private func delete() async {
        guard let client = model.client else { return }
        do {
            try await client.deleteDocument(id: document.id, idempotencyKey: writes.key)
            writes.didSucceed()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the delete. Delete again to retry; it won't be applied twice." : errorMessage(error)
        }
    }

    /// A 404: the document was deleted (or never saved and purged); the row behind refreshes when this closes.
    private func show(_ error: Error, _ message: String? = nil) {
        if case .api(status: 404, _) = error as? ClientError {
            gone = true
            self.error = "This document is no longer available."
        } else {
            self.error = message ?? errorMessage(error)
        }
    }
}

extension View {
    /// A "View document" row under this one when `link`'s record has kept pages; `onChange` runs when the viewer closes (a re-read
    /// may have updated records, a delete removed the pages).
    func keptDocument(_ link: DocumentLink, onChange: @escaping () async -> Void) -> some View {
        modifier(KeptDocumentRow(link: link, onChange: onChange))
    }
}

private struct KeptDocumentRow: ViewModifier {
    @Environment(AppModel.self) private var model
    let link: DocumentLink
    let onChange: () async -> Void
    @State private var document: KeptDocument?
    @State private var viewing = false

    func body(content: Content) -> some View {
        content
            .task(id: link) { await load() }
            .sheet(isPresented: $viewing, onDismiss: { Task { await load(); await onChange() } }, content: {
                if let document { DocumentViewer(document: document) }
            })
        if document != nil {
            Button("View document") { viewing = true }
        }
    }

    /// Without the pages (none kept, or a failed load) there's no row.
    private func load() async {
        document = try? await model.client?.documents(linkedTo: link).first
    }
}
