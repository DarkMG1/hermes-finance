import HermesKit
import PDFKit
import PhotosUI
import SwiftUI
import VisionKit

/// What the flow works on: the pages, in memory only, or none to enter the document by hand.
private struct Capture: Identifiable {
    let id = UUID()
    let kind: ProfileKind
    let pages: [UIImage]
    /// pages left off past the limit
    let dropped: Int
}

private struct DocumentCapture: ViewModifier {
    @Binding var kind: ProfileKind?
    let onSaved: () async -> Void
    @State private var chosen: ProfileKind?
    @State private var choosingSource = false
    @State private var scanning = false
    @State private var choosingPhotos = false
    @State private var choosingPDF = false
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var capture: Capture?
    @State private var unreadable: String?
    @State private var opening = false

    func body(content: Content) -> some View {
        content
            .onChange(of: kind) { _, wanted in
                guard let wanted else { return }
                chosen = wanted
                kind = nil
                choosingSource = true
            }
            .confirmationDialog(chosen?.title ?? "", isPresented: $choosingSource, titleVisibility: .visible) {
                if VNDocumentCameraViewController.isSupported {
                    Button("Scan") { scanning = true }
                }
                Button("Choose photos") { choosingPhotos = true }
                Button("Choose PDF") { choosingPDF = true }
                Button("Enter by hand") { show([]) }
            }
            .fullScreenCover(isPresented: $scanning) {
                DocumentScanner(onPages: { pages in
                    scanning = false
                    if !pages.isEmpty { show(pages) }
                })
                .ignoresSafeArea()
            }
            .photosPicker(isPresented: $choosingPhotos, selection: $pickerItems, maxSelectionCount: PageBudget.maxPages, matching: .images)
            .onChange(of: pickerItems) { _, items in
                guard !items.isEmpty else { return }
                pickerItems = []
                Task { await load(items) }
            }
            .fileImporter(isPresented: $choosingPDF, allowedContentTypes: [.pdf]) { result in
                guard case .success(let url) = result else { return }
                opening = true
                Task {
                    defer { opening = false }
                    let read = await Task.detached(priority: .userInitiated) { Self.pdfPages(url) }.value
                    switch read {
                    case .pages(let pages, let count) where !pages.isEmpty: show(pages, of: count)
                    case .locked: unreadable = "This PDF is locked. Remove the password and try again."
                    default: unreadable = "Couldn't open that PDF."
                    }
                }
            }
            .disabled(opening)
            .overlay {
                if opening {
                    ProgressView("Opening…").padding(Space.l).background(.regularMaterial, in: RoundedRectangle(cornerRadius: Radius.medium))
                }
            }
            .alert(unreadable ?? "", isPresented: Binding(get: { unreadable != nil }, set: { if !$0 { unreadable = nil } })) {}
            // every way out, a swipe included, refreshes: something may have been saved
            .sheet(item: $capture, onDismiss: { Task { await onSaved() } }, content: ProfileCaptureFlow.init)
    }

    private func show(_ pages: [UIImage], of count: Int? = nil) {
        guard let chosen else { return }
        capture = Capture(kind: chosen, pages: Array(pages.prefix(PageBudget.maxPages)), dropped: max((count ?? pages.count) - PageBudget.maxPages, 0))
    }

    private func load(_ items: [PhotosPickerItem]) async {
        opening = true
        defer { opening = false }
        var pages: [UIImage] = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                unreadable = "Couldn't read that photo."
                return
            }
            pages.append(image)
        }
        show(pages)
    }

    enum PDFRead: Sendable {
        /// the first pages and how many the file has
        case pages([UIImage], count: Int)
        case locked, unreadable
    }

    /// The first pages at about 200 dpi, the long side at most 2000 px; read in place, nothing copied.
    nonisolated static func pdfPages(_ url: URL) -> PDFRead {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let doc = PDFDocument(url: url) else { return .unreadable }
        guard !doc.isLocked else { return .locked }
        let pages = (0..<min(doc.pageCount, PageBudget.maxPages)).compactMap { i -> UIImage? in
            guard let page = doc.page(at: i) else { return nil }
            let bounds = page.bounds(for: .cropBox)
            let side = min(max(bounds.width, bounds.height) * 200 / 72, 2000)
            // fits the square, applying the page's rotation and box origin; the image is scale 1 (checked on the simulator)
            return page.thumbnail(of: CGSize(width: side, height: side), for: .cropBox)
        }
        return .pages(pages, count: doc.pageCount)
    }
}

extension View {
    /// Setting `kind` asks for a source (scan, photos, PDF or by hand), then blacks out identifiers, reads the document and opens
    /// its review form; `onSaved` runs whenever the flow closes.
    func profileCapture(kind: Binding<ProfileKind?>, onSaved: @escaping () async -> Void) -> some View {
        modifier(DocumentCapture(kind: kind, onSaved: onSaved))
    }
}

/// Preview and read, then the review form; by hand goes straight to an empty form.
private struct ProfileCaptureFlow: View {
    let capture: Capture
    @State private var read: ProfileReadResult?
    @State private var byHand = false

    var body: some View {
        if let read {
            ProfileDraftForm(kind: capture.kind, draft: read.draft, uncertain: Set(read.uncertain))
        } else if byHand || capture.pages.isEmpty {
            ProfileDraftForm(kind: capture.kind, draft: .empty(capture.kind), uncertain: [])
        } else {
            RedactionPreview(kind: capture.kind, originals: capture.pages, dropped: capture.dropped,
                             onRead: { read = $0 }, onByHand: { byHand = true })
        }
    }
}

extension ProfileKind {
    var title: String {
        switch self {
        case .taxReturn: "Tax return"
        case .taxForm: "W-2 or 1099"
        case .payStub: "Pay stub"
        case .offer: "Offer letter"
        }
    }
}

extension ProfileDraft {
    static func empty(_ kind: ProfileKind) -> ProfileDraft {
        switch kind {
        case .taxReturn: .taxReturn(TaxReturnBody())
        case .taxForm: .taxForm(TaxFormBody())
        case .payStub: .payStub(PayStubBody(), employer: nil)
        case .offer: .offer(CreateJobBody(), grants: [])
        }
    }
}
