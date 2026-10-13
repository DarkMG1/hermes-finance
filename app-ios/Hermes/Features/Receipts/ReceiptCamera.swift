import PhotosUI
import SwiftUI

private struct ReceiptCamera: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(ReceiptQueue.self) private var queue
    @Binding var isPresented: Bool
    @State private var takingPhoto = false
    @State private var choosingPhoto = false
    @State private var pickerItem: PhotosPickerItem?
    @State private var unreadable = false

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented) { _, wanted in
                guard wanted else { return }
                isPresented = false
                if UIImagePickerController.isSourceTypeAvailable(.camera) { takingPhoto = true } else { choosingPhoto = true }
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
                    await queue.add(picked, client: model.client)
                }
            }
            .alert("Couldn't read that photo.", isPresented: $unreadable) {}
            .fullScreenCover(isPresented: $takingPhoto) {
                CameraPicker { photo in
                    takingPhoto = false
                    guard let photo else { return }
                    Task { await queue.add(photo, client: model.client) }
                }
                .ignoresSafeArea()
            }
    }
}

extension View {
    /// Set `isPresented` true to snap a receipt (camera, or the photo library without one); the photo joins the upload queue.
    func receiptCamera(isPresented: Binding<Bool>) -> some View { modifier(ReceiptCamera(isPresented: isPresented)) }
}
