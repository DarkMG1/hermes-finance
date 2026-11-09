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

/// Where the pages come from, picked with the document type from the + menu.
enum CaptureSource: CaseIterable {
    case scan, photos, pdf, byHand

    var title: String {
        switch self {
        case .scan: "Scan"
        case .photos: "Choose photos"
        case .pdf: "Choose PDF"
        case .byHand: "Enter by hand"
        }
    }

    static var available: [CaptureSource] { allCases.filter { $0 != .scan || VNDocumentCameraViewController.isSupported } }
}

struct CaptureRequest: Equatable {
    let kind: ProfileKind
    let source: CaptureSource
    /// a PDF sent from another app, already in memory
    var opened: OpenedPDF?
}

/// A PDF sent from another app, in memory only: iOS's copy of it is deleted as soon as it's read.
struct OpenedPDF: Equatable, Sendable {
    let id = UUID()
    let pages: [UIImage]
    /// how many pages the file has
    let count: Int
    static func == (a: OpenedPDF, b: OpenedPDF) -> Bool { a.id == b.id }
}

enum PDFFile {
    enum Read: Sendable {
        /// the first pages and how many the file has
        case pages([UIImage], count: Int)
        case locked, unreadable

        var problem: String? {
            switch self {
            case .pages(let pages, _) where !pages.isEmpty: nil
            case .locked: "This PDF is locked. Remove the password and try again."
            default: "Couldn't open that PDF."
            }
        }
    }

    /// The first pages at about 200 dpi, the long side at most 2000 px (1400 px in a long file, so every page fits in memory). The importer
    /// opens the file in place (a security-scoped URL to the original); a provider or another app that hands over a copy puts it in this
    /// app's container, and that copy is deleted once read.
    nonisolated static func pages(_ url: URL) -> Read {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
            let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
            if url.resolvingSymlinksInPath().path.hasPrefix(home) { try? FileManager.default.removeItem(at: url) }
        }
        guard let doc = PDFDocument(url: url) else { return .unreadable }
        guard !doc.isLocked else { return .locked }
        let longest: CGFloat = doc.pageCount > PageBudget.fullSizePages ? 1400 : 2000
        let pages = (0..<min(doc.pageCount, PageBudget.maxPages)).compactMap { i -> UIImage? in
            guard let page = doc.page(at: i) else { return nil }
            let bounds = page.bounds(for: .cropBox)
            let side = min(max(bounds.width, bounds.height) * 200 / 72, longest)
            // fits the square, applying the page's rotation and box origin; the image is scale 1 (checked on the simulator)
            return page.thumbnail(of: CGSize(width: side, height: side), for: .cropBox)
        }
        return .pages(pages, count: doc.pageCount)
    }
}

private struct DocumentCapture: ViewModifier {
    @Binding var request: CaptureRequest?
    let onSaved: () async -> Void
    @State private var chosen: ProfileKind?
    @State private var scanning = false
    /// the scanner's pages, shown once its cover has gone so the review sheet isn't asked for mid-dismissal
    @State private var scanned: [UIImage] = []
    @State private var choosingPhotos = false
    @State private var choosingPDF = false
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var capture: Capture?
    @State private var unreadable: String?
    @State private var opening = false

    func body(content: Content) -> some View {
        content
            // a Menu, not a dialog: iOS 26 anchors a dialog to its source view, and covers opened straight from one stuck
            .onChange(of: request) { _, wanted in if let wanted { open(wanted) } }
            .fullScreenCover(isPresented: $scanning, onDismiss: {
                if !scanned.isEmpty { show(scanned) }
                scanned = []
            }, content: {
                DocumentScanner(onPages: { pages in
                    scanned = pages
                    scanning = false
                })
                .ignoresSafeArea()
            })
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
                    let read = await Task.detached(priority: .userInitiated) { PDFFile.pages(url) }.value
                    if case .pages(let pages, let count) = read, read.problem == nil { show(pages, of: count) } else { unreadable = read.problem }
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

    private func open(_ wanted: CaptureRequest) {
        chosen = wanted.kind
        request = nil
        if let opened = wanted.opened { return show(opened.pages, of: opened.count) }
        switch wanted.source {
        case .scan: scanning = true
        case .photos: choosingPhotos = true
        case .pdf: choosingPDF = true
        case .byHand: show([])
        }
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
}

extension View {
    /// Setting `request` opens its source (scan, photos, PDF or by hand), then blacks out identifiers, reads the document and opens
    /// its review form; `onSaved` runs whenever the flow closes.
    func profileCapture(_ request: Binding<CaptureRequest?>, onSaved: @escaping () async -> Void) -> some View {
        modifier(DocumentCapture(request: request, onSaved: onSaved))
    }
}

/// Preview and read, then the review form, once per pay stub when the pages hold several; by hand goes straight to an empty form.
private struct ProfileCaptureFlow: View {
    @Environment(\.profileDrafting) private var drafting
    let capture: Capture
    @State private var reads: [ProfileReadResult] = []
    @State private var at = 0
    /// the job picked on the stub before, offered on the next
    @State private var jobId: String?
    @State private var byHand = false

    var body: some View {
        Group {
            if at < reads.count {
                let read = reads[at]
                ProfileDraftForm(kind: capture.kind, draft: read.draft, uncertain: Set(read.uncertain), step: reads.count > 1 ? (at + 1, reads.count) : nil,
                                 jobId: jobId, next: at + 1 < reads.count ? { jobId = $0; at += 1 } : nil)
                    .id(at)
            } else if byHand || capture.pages.isEmpty {
                ProfileDraftForm(kind: capture.kind, draft: .empty(capture.kind), uncertain: [])
            } else {
                RedactionPreview(kind: capture.kind, originals: capture.pages, dropped: capture.dropped,
                                 onRead: { reads = $0.reads }, onByHand: { byHand = true })
            }
        }
        .onAppear { drafting.wrappedValue = true }
        .onDisappear { drafting.wrappedValue = false }
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
        case .taxForm: .taxForm({ var f = TaxFormBody(); f.kind = "w2"; return f }())
        case .payStub: .payStub(PayStubBody(), employer: nil)
        case .offer: .offer(CreateJobBody(), grants: [])
        }
    }
}
