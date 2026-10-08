import SwiftUI

struct Sheet<Content: View>: View {
    let title: String
    var saveTitle = "Save"
    var canSave = true
    var busy = false
    let onCancel: () -> Void
    let onSave: (() -> Void)?
    @ViewBuilder var content: Content

    var body: some View {
        NavigationStack {
            Form { content }
                .themedForm()
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                    if let onSave {
                        ToolbarItem(placement: .confirmationAction) {
                            if busy { ProgressView() } else { Button(saveTitle, action: onSave).disabled(!canSave) }
                        }
                    }
                }
        }
    }
}
