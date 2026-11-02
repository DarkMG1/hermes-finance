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
                guard let pdf = Self.pdfPages(url), !pdf.pages.isEmpty else {
                    unreadable = "Couldn't open that PDF."
                    return
                }
                show(pdf.pages, of: pdf.count)
            }
            .alert(unreadable ?? "", isPresented: Binding(get: { unreadable != nil }, set: { if !$0 { unreadable = nil } })) {}
            .sheet(item: $capture) { capture in
                ProfileCaptureFlow(capture: capture, onSaved: onSaved)
            }
    }

    private func show(_ pages: [UIImage], of count: Int? = nil) {
        guard let chosen else { return }
        capture = Capture(kind: chosen, pages: Array(pages.prefix(PageBudget.maxPages)), dropped: max((count ?? pages.count) - PageBudget.maxPages, 0))
    }

    private func load(_ items: [PhotosPickerItem]) async {
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

    /// The first pages at about 200 dpi, upright, the long side at most 2000 px, and how many the file has; read in place, nothing copied.
    static func pdfPages(_ url: URL) -> (pages: [UIImage], count: Int)? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let doc = PDFDocument(url: url), !doc.isLocked else { return nil }
        let pages = (0..<min(doc.pageCount, PageBudget.maxPages)).compactMap { i -> UIImage? in
            guard let page = doc.page(at: i) else { return nil }
            let bounds = page.bounds(for: .mediaBox)
            let k = min(200 / 72, 2000 / max(bounds.width, bounds.height, 1))
            let turned = page.rotation % 180 != 0
            let size = CGSize(width: (turned ? bounds.height : bounds.width) * k, height: (turned ? bounds.width : bounds.height) * k)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
                UIColor.white.setFill()
                ctx.fill(CGRect(origin: .zero, size: size))
                // PDF space runs bottom up; drawing applies the page's rotation itself
                ctx.cgContext.translateBy(x: 0, y: size.height)
                ctx.cgContext.scaleBy(x: k, y: -k)
                page.draw(with: .mediaBox, to: ctx.cgContext)
            }
        }
        return (pages, doc.pageCount)
    }
}

extension View {
    /// Setting `kind` asks for a source (scan, photos, PDF or by hand), then blacks out identifiers, reads the document and opens
    /// its review form; `onSaved` runs after anything was saved.
    func profileCapture(kind: Binding<ProfileKind?>, onSaved: @escaping () async -> Void) -> some View {
        modifier(DocumentCapture(kind: kind, onSaved: onSaved))
    }
}

/// Preview and read, then the review form; by hand goes straight to an empty form.
private struct ProfileCaptureFlow: View {
    let capture: Capture
    let onSaved: () async -> Void
    @State private var read: ProfileReadResult?
    @State private var byHand = false

    var body: some View {
        if let read {
            ProfileDraftForm(kind: capture.kind, draft: read.draft, uncertain: Set(read.uncertain), onSaved: onSaved)
        } else if byHand || capture.pages.isEmpty {
            ProfileDraftForm(kind: capture.kind, draft: .empty(capture.kind), uncertain: [], onSaved: onSaved)
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
