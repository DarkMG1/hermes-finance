import HermesKit
import SwiftUI
import Vision

/// A page upright, its long side at most 2000 px, and what is blacked out on it (normalized, origin top left).
struct RedactedPage: Sendable {
    let image: UIImage
    let found: [Box]
    var drawn: [Box] = []
    var boxes: [Box] { found + drawn }
}

/// Finds identifiers on each page and blacks them out; the owner checks every page, drags over anything else to hide, then sends.
struct RedactionPreview: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let kind: ProfileKind
    let originals: [UIImage]
    /// pages past the limit, not sent
    let dropped: Int
    let onRead: (ProfileReadResult) -> Void
    let onByHand: () -> Void

    @State private var pages: [RedactedPage] = []
    @State private var preparing = true
    @State private var index = 0
    @State private var reading = false
    @State private var error: String?
    @State private var canRetry = false
    @GestureState private var drag: (start: CGPoint, end: CGPoint)?

    var body: some View {
        NavigationStack {
            VStack(spacing: Space.m) {
                if preparing {
                    Spacer()
                    ProgressView("Finding ID numbers…")
                    Spacer()
                } else if pages.isEmpty {
                    Spacer()
                    InlineError(message: "Couldn't check these pages for ID numbers, so nothing was sent.")
                    Button("Enter by hand", action: onByHand)
                    Spacer()
                } else {
                    pageView(pages[index]).frame(maxHeight: .infinity)
                    HStack {
                        Button { index -= 1 } label: { Image(systemName: "chevron.left") }
                            .disabled(index == 0)
                            .accessibilityLabel("Previous page")
                        Spacer()
                        Text("Page \(index + 1) of \(pages.count) · \(pages[index].boxes.count) hidden").textStyle(.subhead)
                        Spacer()
                        Button { index += 1 } label: { Image(systemName: "chevron.right") }
                            .disabled(index == pages.count - 1)
                            .accessibilityLabel("Next page")
                    }
                    if !pages[index].drawn.isEmpty {
                        Button("Undo last box") { pages[index].drawn.removeLast() }.disabled(reading)
                    }
                    Text("Black boxes hide ID and account numbers. Drag across anything else you want hidden.")
                        .textStyle(.caption, color: Palette.secondaryText)
                    if dropped > 0 {
                        Text("Only the first \(PageBudget.maxPages) pages are read.").textStyle(.caption, color: Palette.secondaryText)
                    }
                    if reading {
                        HStack { ProgressView(); Text("Reading…").textStyle(.subhead, color: Palette.secondaryText) }
                    } else if let error {
                        InlineError(message: error)
                        HStack(spacing: Space.l) {
                            if canRetry { Button("Retry") { Task { await send() } } }
                            Button("Enter by hand", action: onByHand)
                        }
                    }
                }
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity)
            .background(Palette.background)
            .navigationTitle(kind.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(reading) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await send() } }.disabled(pages.isEmpty || reading)
                }
            }
        }
        .interactiveDismissDisabled(reading)
        .task { await prepare() }
    }

    private func pageView(_ page: RedactedPage) -> some View {
        Image(uiImage: page.image)
            .resizable()
            .scaledToFit()
            .overlay {
                GeometryReader { geo in
                    let w = geo.size.width, h = geo.size.height
                    ForEach(Array(page.boxes.enumerated()), id: \.offset) { _, b in
                        Rectangle().fill(Color.black)
                            .frame(width: b.w * w, height: b.h * h)
                            .position(x: (b.x + b.w / 2) * w, y: (b.y + b.h / 2) * h)
                    }
                    if let drag {
                        let r = Self.box(drag.start, drag.end, in: geo.size)
                        Rectangle().stroke(Palette.accent, lineWidth: 2)
                            .frame(width: r.w * w, height: r.h * h)
                            .position(x: (r.x + r.w / 2) * w, y: (r.y + r.h / 2) * h)
                    }
                    Color.clear.contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: Space.xs)
                            .updating($drag) { value, state, _ in state = (value.startLocation, value.location) }
                            .onEnded { value in
                                let b = Self.box(value.startLocation, value.location, in: geo.size)
                                if b.w > 0, b.h > 0 { pages[index].drawn.append(b) }
                            })
                        .disabled(reading)
                }
            }
            .accessibilityElement(children: .ignore)
            // dragging has no VoiceOver path; hiding the whole page is always safe
            .accessibilityAction(named: "Black out whole page") { pages[index].drawn.append(Box(x: 0, y: 0, w: 1, h: 1)) }
            .accessibilityLabel("Page \(index + 1) of \(pages.count), \(page.boxes.count) \(page.boxes.count == 1 ? "item" : "items") hidden")
    }

    private static func box(_ a: CGPoint, _ b: CGPoint, in size: CGSize) -> Box {
        func clamp(_ v: CGFloat, _ side: CGFloat) -> Double { Double(min(max(v / max(side, 1), 0), 1)) }
        let x0 = clamp(min(a.x, b.x), size.width), x1 = clamp(max(a.x, b.x), size.width)
        let y0 = clamp(min(a.y, b.y), size.height), y1 = clamp(max(a.y, b.y), size.height)
        return Box(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }

    private func prepare() async {
        guard preparing else { return }
        let originals = originals
        let found = await Task.detached(priority: .userInitiated) { originals.map(Self.redacted) }.value
        // a page Vision couldn't check is never sent: all or nothing
        pages = found.contains { $0 == nil } ? [] : found.compactMap { $0 }
        preparing = false
    }

    nonisolated private static func redacted(_ original: UIImage) -> RedactedPage? {
        let px = CGSize(width: original.size.width * original.scale, height: original.size.height * original.scale)
        guard px.width > 0, px.height > 0 else { return nil }
        let k = min(1, 2000 / max(px.width, px.height))
        let size = CGSize(width: (px.width * k).rounded(), height: (px.height * k).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        // drawn upright and flattened on white, so Vision's boxes and the sent JPEG share one frame
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            original.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let cg = image.cgImage else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        do { try VNImageRequestHandler(cgImage: cg).perform([request]) } catch { return nil }
        let lines = (request.results ?? []).compactMap { o -> TextLine? in
            guard let text = o.topCandidates(1).first?.string else { return nil }
            let b = o.boundingBox
            // Vision's origin is bottom left
            return TextLine(text: text, box: Box(x: b.minX, y: 1 - b.minY - b.height, w: b.width, h: b.height))
        }
        return RedactedPage(image: image, found: Redaction.boxes(lines))
    }

    nonisolated private static func blackedOut(_ page: RedactedPage) -> UIImage {
        let size = page.image.size
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            page.image.draw(at: .zero)
            UIColor.black.setFill()
            for b in page.boxes {
                ctx.fill(CGRect(x: b.x * size.width, y: b.y * size.height, width: b.w * size.width, height: b.h * size.height))
            }
        }
    }

    private func send() async {
        guard let client = model.client else { return }
        reading = true
        error = nil
        defer { reading = false }
        let pages = pages
        let jpegs = await Task.detached(priority: .userInitiated) {
            let images = pages.map(Self.blackedOut)
            return PageBudget.fit(pages: images.count) { i, side, quality in
                ReceiptImage.jpeg(images[i], longSide: CGFloat(side), quality: CGFloat(quality))
            }
        }.value
        guard let jpegs else {
            error = "These pages are too large to send. Try fewer pages."
            canRetry = false
            return
        }
        do {
            onRead(try await client.readProfileDocument(kind: kind, pages: jpegs))
        } catch {
            let code = if case .api(_, let body) = error as? ClientError { body.code } else { "" }
            canRetry = !["AI_CREDITS_EXHAUSTED", "READER_NOT_CONFIGURED"].contains(code)
            self.error = switch code {
            case "UNREADABLE", "READ_FAILED": "Couldn't read this."
            case "READ_IN_PROGRESS": "Another read is running."
            case "READER_NOT_CONFIGURED": "Reading isn't set up on the server."
            default: errorMessage(error)
            }
        }
    }
}
