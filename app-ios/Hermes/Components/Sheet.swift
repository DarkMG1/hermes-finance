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
            ScrollViewReader { scroller in
                Form { content.environment(\.sheetScroller, scroller) }
                    .themedForm()
                    // swiping the form down closes any keyboard (the number pad has no return key); no keyboard bar:
                    // on iOS 26 it is see-through but still takes taps meant for the field behind it
                    .scrollDismissesKeyboard(.interactively)
                    .navigationTitle(title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
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
        }
        .interactiveDismissDisabled(busy || unresolved)
    }
}
