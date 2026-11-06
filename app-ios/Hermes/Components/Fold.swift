import SwiftUI

/// A titled section that opens and closes inside a Card. DisclosureGroup outside a List animates its content
/// separately from the card, so the card stays full height for a moment after closing.
struct Fold<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    @State private var isExpanded = false

    var body: some View {
        Button { isExpanded.toggle() } label: {
            HStack {
                Text(title).textStyle(.headline)
                Spacer()
                Image(systemName: "chevron.right")
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .foregroundStyle(Palette.accent)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        if isExpanded { content }
    }
}
