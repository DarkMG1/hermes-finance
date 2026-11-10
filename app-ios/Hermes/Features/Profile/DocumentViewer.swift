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
    @State private var deleting = false
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
                if pages[index] == nil, error != nil, !gone { Button("Retry") { Task { await loadPage() } } }
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
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(reading || deleting) }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Re-read") { Task { await readAgain() } }.disabled(reading || deleting || gone)
                    Spacer()
                    Button("Delete document", role: .destructive) { confirmingDelete = true }
                        .disabled(reading || deleting || gone)
                        .confirmationDialog("Delete document?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                            Button("Delete", role: .destructive) { Task { await delete() } }
                        } message: { Text("The pages are deleted. The saved numbers stay.") }
                }
            }
        }
        .interactiveDismissDisabled(reading || deleting)
        .task(id: index) { await loadPage() }
        // the review saves each draft as an update of the record it matched; closing it closes this too, so the list behind refreshes
        .sheet(isPresented: Binding(get: { reread != nil }, set: { if !$0 { reread = nil } }), onDismiss: { dismiss() }, content: {
            if let reread { ProfileCaptureFlow(reread: reread) }
        })
    }

    private func loadPage() async {
        guard !gone else { return }
        error = nil
        guard pages[index] == nil, let client = model.client else { return }
        let page = index
        do {
            let data = try await client.documentPage(id: document.id, page: page + 1)
            if let image = UIImage(data: data) { pages[page] = image } else if !Task.isCancelled { error = "Couldn't show this page." }
        } catch {
            // paged on before it arrived
            if !Task.isCancelled { show(error) }
        }
    }

    private func readAgain() async {
        guard !reading, !deleting, let client = model.client else { return }
        reading = true
        error = nil
        defer { reading = false }
        do {
            let read = try await client.rereadDocument(id: document.id)
            if read.reads.isEmpty { error = "Couldn't read this." } else { reread = read }
        } catch {
            show(error, RedactionPreview.readProblem(error))
        }
    }

    private func delete() async {
        guard !reading, !deleting, let client = model.client else { return }
        deleting = true
        defer { deleting = false }
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
    /// A "View document" row under this one when its record has kept pages; `onChange` runs when the viewer closes (a re-read may have
    /// updated records, a delete removed the pages), so the screen reloads its records and documents.
    func keptDocument(_ document: KeptDocument?, onChange: @escaping () async -> Void) -> some View {
        modifier(KeptDocumentRow(document: document, onChange: onChange))
    }
}

extension [KeptDocument] {
    /// Each record's document, newest first wins; a screen fetches the list once per load.
    var byLink: [DocumentLink: KeptDocument] {
        Dictionary(flatMap { d in d.links.map { ($0, d) } }, uniquingKeysWith: { newer, _ in newer })
    }
}

private struct KeptDocumentRow: ViewModifier {
    let document: KeptDocument?
    let onChange: () async -> Void
    /// kept apart from `document`, so a reload behind the open viewer doesn't empty it
    @State private var viewing: KeptDocument?

    func body(content: Content) -> some View {
        content.sheet(item: $viewing, onDismiss: { Task { await onChange() } }, content: DocumentViewer.init)
        if let document {
            Button("View document") { viewing = document }
        }
    }
}
