import HermesKit
import PhotosUI
import SwiftUI
import UIKit

/// A transaction's receipt photo: add from the camera or library, view full screen, replace, delete. Each change is saved at once.
struct ReceiptSection: View {
    @Environment(AppModel.self) private var model
    let transactionId: String
    let hadReceipt: Bool
    /// Owned by the sheet, so it can't close mid-upload or mid-delete.
    @Binding var busy: Bool
    let onChange: () -> Void

    @State private var image: UIImage?
    @State private var loading = false
    @State private var error: String?
    @State private var pickerItem: PhotosPickerItem?
    @State private var choosingPhoto = false
    @State private var takingPhoto = false
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
            } else if loading {
                ProgressView().frame(maxWidth: .infinity)
            }
            Menu {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Take photo", systemImage: "camera") { takingPhoto = true }
                }
                Button("Choose photo", systemImage: "photo") { choosingPhoto = true }
            } label: {
                if busy { ProgressView() } else { Text(image == nil ? "Add receipt" : "Replace receipt") }
            }
            .disabled(busy || loading)
            // on the Menu, not the Group: in a Form each Group child is its own row and would get its own copy
            .photosPicker(isPresented: $choosingPhoto, selection: $pickerItem, matching: .images)
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                pickerItem = nil
                Task {
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
                    if let photo { Task { await upload(photo) } }
                }
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $viewing) {
                if let image { ReceiptViewer(image: image) }
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
        guard hadReceipt, let client = model.client else { return }
        loading = true
        defer { loading = false }
        do {
            image = UIImage(data: try await client.receipt(transactionId: transactionId))
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func upload(_ photo: UIImage) async {
        guard let client = model.client else { return }
        guard let jpeg = ReceiptImage.jpeg(photo) else {
            error = "Couldn't prepare that photo."
            return
        }
        busy = true
        defer { busy = false }
        error = nil
        do {
            try await client.putReceipt(transactionId: transactionId, jpeg: jpeg)
            image = UIImage(data: jpeg)
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
            onChange()
        } catch {
            self.error = errorMessage(error)
        }
    }
}

/// Receipts are stored small: a 1600 px long side at JPEG quality 0.7 stays readable for itemizing.
enum ReceiptImage {
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

/// Full screen; pinch to zoom, drag to move while zoomed, double-tap to toggle zoom.
struct ReceiptViewer: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero

    var body: some View {
        NavigationStack {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(zoom * pinch)
                .offset(x: offset.width + drag.width, y: offset.height + drag.height)
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
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
                .accessibilityLabel("Receipt photo")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}
