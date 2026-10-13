import PhotosUI
import SwiftUI
import VisionKit

private struct ReceiptCamera: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(ReceiptQueue.self) private var queue
    @Binding var isPresented: Bool
    let scanDirectly: Bool
    let onCaptured: () -> Void
    @State private var choosingSource = false
    @State private var scanning = false
    @State private var takingPhoto = false
    @State private var choosingPhoto = false
    @State private var pickerItem: PhotosPickerItem?
    @State private var unreadable = false

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented) { _, wanted in
                guard wanted else { return }
                isPresented = false
                let canScan = VNDocumentCameraViewController.isSupported
                let canSnap = UIImagePickerController.isSourceTypeAvailable(.camera)
                if scanDirectly && canScan { scanning = true } else if canScan || canSnap { choosingSource = true } else { choosingPhoto = true }
            }
            .confirmationDialog("Receipt", isPresented: $choosingSource) {
                if VNDocumentCameraViewController.isSupported {
                    Button("Scan receipt") { scanning = true }
                }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Take photo") { takingPhoto = true }
                }
                Button("Choose photo") { choosingPhoto = true }
            }
            .fullScreenCover(isPresented: $scanning) {
                DocumentScanner { scan in
                    scanning = false
                    guard let scan else { return }
                    add(scan, scan: true)
                }
                .ignoresSafeArea()
            }
            .photosPicker(isPresented: $choosingPhoto, selection: $pickerItem, matching: .images)
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                pickerItem = nil
                Task {
                    guard let data = try? await item.loadTransferable(type: Data.self), let picked = UIImage(data: data) else {
                        unreadable = true
                        return
                    }
                    add(picked)
                }
            }
            .alert("Couldn't read that photo.", isPresented: $unreadable) {}
            .fullScreenCover(isPresented: $takingPhoto) {
                CameraPicker { photo in
                    takingPhoto = false
                    guard let photo else { return }
                    add(photo)
                }
                .ignoresSafeArea()
            }
    }

    private func add(_ image: UIImage, scan: Bool = false) {
        onCaptured()
        Task { await queue.add(image, scan: scan, client: model.client) }
    }
}

extension View {
    /// Set `isPresented` true to snap a receipt (scan, camera or library; `scanDirectly` skips the choice); the photo joins the upload queue
    /// and `onCaptured` runs.
    func receiptCamera(isPresented: Binding<Bool>, scanDirectly: Bool = false, onCaptured: @escaping () -> Void = {}) -> some View {
        modifier(ReceiptCamera(isPresented: isPresented, scanDirectly: scanDirectly, onCaptured: onCaptured))
    }
}
