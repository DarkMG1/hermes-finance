import SwiftUI

extension EnvironmentValues {
    /// The enclosing Sheet's form scroller.
    @Entry var sheetScroller: ScrollViewProxy?
}

/// A multi-line notes box; a Form doesn't scroll a multi-line field above the keyboard, so it scrolls itself.
struct NotesField: View {
    @Binding var text: String
    var error: String?
    @Environment(\.sheetScroller) private var scroller
    @FocusState private var focused: Bool
    @State private var id = UUID()

    var body: some View {
        Field(label: "Notes", error: error) {
            TextField("Notes", text: $text, axis: .vertical).lineLimit(1...6).focused($focused)
        }
        .id(id)
        .onChange(of: focused) { _, isFocused in
            guard isFocused, let scroller else { return }
            Task {
                // wait for the keyboard to finish resizing the form
                try? await Task.sleep(for: .milliseconds(350))
                withAnimation { scroller.scrollTo(id, anchor: .bottom) }
            }
        }
    }
}
