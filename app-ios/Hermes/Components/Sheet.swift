import SwiftUI

struct Sheet<Content: View>: View {
    let title: String
    var saveTitle = "Save"
    var canSave = true
    var busy = false
    /// A write's outcome is unknown and a retry is pending.
    var unresolved = false
    let onCancel: () -> Void
    let onSave: (() -> Void)?
    @ViewBuilder var content: Content
    @State private var confirmingClose = false

    var body: some View {
        NavigationStack {
            Form { content }
                .themedForm()
                .scrollDismissesKeyboard(.interactively)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // the number pad has no return key, so give every keyboard a way out
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                    }
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { unresolved ? confirmingClose = true : onCancel() }.disabled(busy) }
                    if let onSave {
                        ToolbarItem(placement: .confirmationAction) {
                            if busy { ProgressView() } else { Button(saveTitle, action: onSave).disabled(!canSave) }
                        }
                    }
                }
                .confirmationDialog("This may already have been saved. Close anyway?", isPresented: $confirmingClose, titleVisibility: .visible) {
                    Button("Close", role: .destructive, action: onCancel)
                }
        }
        .interactiveDismissDisabled(busy || unresolved)
    }
}
