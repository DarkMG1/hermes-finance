import HermesKit
import PhotosUI
import SwiftUI
import UIKit
import VisionKit

/// A transaction's receipt photo: add from the camera or library, view full screen, replace, delete. Each change is saved at once.
struct ReceiptSection: View {
    @Environment(AppModel.self) private var model
    let transactionId: String
    let hadReceipt: Bool
    /// Owned by the sheet, so it can't close mid-upload or mid-delete.
    @Binding var busy: Bool
    /// Opens the Itemize screen; nil hides the button.
    var onItemize: (() -> Void)?
    let onChange: () -> Void

    @State private var image: UIImage?
    @State private var loading = false
    @State private var error: String?
    @State private var loadError: String?
    /// Deleted here, so `hadReceipt` no longer holds.
    @State private var removed = false
    @State private var pickerItem: PhotosPickerItem?
    @State private var choosingSource = false
    @State private var choosingPhoto = false
    @State private var takingPhoto = false
    @State private var scanning = false
    @State private var viewing = false
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if let image {
                Button { viewing = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: Space.xxl * 5)
                        .clipShape(RoundedRectangle(cornerRadius: Space.s))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Receipt photo")
                .accessibilityHint("Opens it full screen")
                // here, not on the add Button: that Button is disabled mid-write, and Done must still work
                .fullScreenCover(isPresented: $viewing) {
                    if let image = self.image { ReceiptViewer(image: image) }
                }
                if let onItemize {
                    Button("Itemize", action: onItemize).disabled(busy)
                }
            } else if loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let loadError {
                InlineError(message: loadError)
                Button("Try again") { Task { await load() } }
            }
            // a Button and dialog, not a Menu: a Form row's Menu only answers taps on its text, and a redraw closes it
            Button { choosingSource = true } label: {
                if busy { ProgressView() } else { Text((hadReceipt && !removed) || image != nil ? "Replace receipt" : "Add receipt") }
            }
            .disabled(busy || loading)
            .confirmationDialog("Receipt", isPresented: $choosingSource) {
                if VNDocumentCameraViewController.isSupported {
                    Button("Scan receipt") { scanning = true }
                }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Take photo") { takingPhoto = true }
                }
                Button("Choose photo") { choosingPhoto = true }
            }
            // on the Button, not the Group: in a Form each Group child is its own row and would get its own copy
            .photosPicker(isPresented: $choosingPhoto, selection: $pickerItem, matching: .images)
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                pickerItem = nil
                guard !busy else { return }
                busy = true
                Task {
                    defer { busy = false }
                    guard let data = try? await item.loadTransferable(type: Data.self), let picked = UIImage(data: data) else {
                        error = "Couldn't read that photo."
                        return
                    }
                    await upload(picked)
                }
            }
            .fullScreenCover(isPresented: $takingPhoto) {
                CameraPicker { photo in
                    takingPhoto = false
                    guard let photo, !busy else { return }
                    busy = true
                    Task {
                        defer { busy = false }
                        await upload(photo)
                    }
                }
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $scanning) {
                DocumentScanner { scan in
                    scanning = false
                    guard let scan, !busy else { return }
                    busy = true
                    Task {
                        defer { busy = false }
                        await upload(scan, scan: true)
                    }
                }
                .ignoresSafeArea()
            }
            .task { await load() }
            if image != nil {
                Button("Delete receipt", role: .destructive) { confirmDelete = true }
                    .disabled(busy)
                    .confirmationDialog("Delete this receipt?", isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Delete", role: .destructive) { Task { await delete() } }
                    }
            }
            InlineError(message: error)
        }
    }

    private func load() async {
        // .task runs again when a full-screen cover closes; keep the photo already shown
        guard hadReceipt, !removed, image == nil, !loading, let client = model.client else { return }
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            image = UIImage(data: try await client.receipt(transactionId: transactionId))
        } catch {
            loadError = errorMessage(error)
        }
    }

    /// The caller sets `busy` before reading the photo and clears it after.
    private func upload(_ photo: UIImage, scan: Bool = false) async {
        guard let client = model.client else { return }
        guard let jpeg = ReceiptImage.jpeg(photo, scan: scan) else {
            error = "Couldn't prepare that photo."
            return
        }
        error = nil
        do {
            try await client.putReceipt(transactionId: transactionId, jpeg: jpeg)
            image = UIImage(data: jpeg)
            loadError = nil
            removed = false
            onChange()
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func delete() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            try await client.deleteReceipt(transactionId: transactionId)
            image = nil
            removed = true
            onChange()
        } catch {
            self.error = errorMessage(error)
        }
    }
}

/// Receipts are stored small: a 1600 px long side at JPEG quality 0.7 stays readable for itemizing.
/// Scans may be tall, so they keep up to 4000 px and step down until under the server's 3 MB limit.
enum ReceiptImage {
    static func jpeg(_ image: UIImage, scan: Bool) -> Data? {
        guard scan else { return jpeg(image) }
        var side: CGFloat = 4000
        while side >= 800 {
            for quality in [0.7, 0.5, 0.35] as [CGFloat] {
                if let data = jpeg(image, longSide: side, quality: quality), data.count <= 2_800_000 { return data }
            }
            side *= 0.75
        }
        return nil
    }

    static func jpeg(_ image: UIImage, longSide: CGFloat = 1600, quality: CGFloat = 0.7) -> Data? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, longSide / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        // draw(in:) applies the photo's orientation, so the stored JPEG is upright
        return UIGraphicsImageRenderer(size: target, format: format).jpegData(withCompressionQuality: quality) { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    let onFinish: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?) -> Void
        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onFinish(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onFinish(nil) }
    }
}

struct DocumentScanner: UIViewControllerRepresentable {
    /// One image: several pages are stitched top to bottom. Nil when cancelled or failed.
    let onFinish: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
        let onFinish: (UIImage?) -> Void
        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            onFinish(Self.stitched((0..<scan.pageCount).map { scan.imageOfPage(at: $0) }))
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { onFinish(nil) }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { onFinish(nil) }

        static func stitched(_ pages: [UIImage]) -> UIImage? {
            guard pages.count > 1 else { return pages.first }
            let width = pages.map(\.size.width).max() ?? 0
            let heights = pages.map { $0.size.width > 0 ? $0.size.height * width / $0.size.width : 0 }
            let total = CGSize(width: width, height: heights.reduce(0, +))
            guard total.width > 0, total.height > 0 else { return nil }
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: total, format: format).image { _ in
                var y: CGFloat = 0
                for (page, height) in zip(pages, heights) {
                    page.draw(in: CGRect(x: 0, y: y, width: width, height: height))
                    y += height
                }
            }
        }
    }
}

/// Full screen; pinch to zoom, drag to move while zoomed, double-tap to toggle zoom.
struct ReceiptViewer: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZoomableImage(image: image)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// A photo on black: pinch to zoom, drag to pan once zoomed, double tap to zoom in or back out.
struct ZoomableImage: View {
    let image: UIImage
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .scaleEffect(zoom * pinch)
            .offset(x: offset.width + drag.width, y: offset.height + drag.height)
            // a zoomed image reaches past the frame and clipping only hides it, so touches belong to the frame
            .allowsHitTesting(false)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            .contentShape(Rectangle())
            .gesture(MagnifyGesture()
                .updating($pinch) { value, state, _ in state = value.magnification }
                .onEnded { value in
                    zoom = min(max(zoom * value.magnification, 1), 5)
                    if zoom == 1 { offset = .zero }
                })
            .simultaneousGesture(DragGesture()
                .updating($drag) { value, state, _ in if zoom > 1 { state = value.translation } }
                .onEnded { value in
                    guard zoom > 1 else { return }
                    offset.width += value.translation.width
                    offset.height += value.translation.height
                })
            .onTapGesture(count: 2) {
                zoom = zoom > 1 ? 1 : 2.5
                if zoom == 1 { offset = .zero }
            }
            .background(Color.black)
            .accessibilityLabel("Receipt photo")
    }
}
