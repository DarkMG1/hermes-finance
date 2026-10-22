import HermesKit
import PhotosUI
import SwiftUI
import VisionKit

private struct ReceiptCamera: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(ReceiptQueue.self) private var queue
    @Binding var isPresented: Bool
    @Binding var busy: Bool
    let scanDirectly: Bool
    let onImage: ((UIImage, Bool) async -> Void)?
    let onCaptured: () -> Void
    @State private var choosingSource = false
    @State private var scanning = false
    @State private var takingPhoto = false
    @State private var choosingPhoto = false
    @State private var pickerItem: PhotosPickerItem?
    @State private var unreadable = false
    @State private var captureClient: APIClient?

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented) { _, wanted in
                guard wanted else { return }
                captureClient = model.client
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
                guard !busy else { return }
                busy = true
                let client = captureClient
                Task { await load(item, client: client) }
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

    private func load(_ item: PhotosPickerItem, client: APIClient?) async {
        defer { busy = false }
        guard let data = try? await item.loadTransferable(type: Data.self), let picked = UIImage(data: data) else {
            unreadable = true
            return
        }
        await deliver(picked, scan: false, client: client)
    }

    private func add(_ image: UIImage, scan: Bool = false) {
        guard !busy else { return }
        busy = true
        let client = captureClient
        Task {
            defer { busy = false }
            await deliver(image, scan: scan, client: client)
        }
    }

    private func deliver(_ image: UIImage, scan: Bool, client: APIClient?) async {
        if client === model.client { onCaptured() }
        if let onImage {
            guard client === model.client else { return }
            await onImage(image, scan)
        } else {
            await queue.add(image, scan: scan, client: client)
        }
    }
}

extension View {
    /// Captures a scan, camera or library image; queues it unless the caller handles `onImage`.
    func receiptCamera(isPresented: Binding<Bool>, busy: Binding<Bool> = .constant(false), scanDirectly: Bool = false,
                       onImage: ((UIImage, Bool) async -> Void)? = nil, onCaptured: @escaping () -> Void = {}) -> some View {
        modifier(ReceiptCamera(isPresented: isPresented, busy: busy, scanDirectly: scanDirectly, onImage: onImage, onCaptured: onCaptured))
    }
}
