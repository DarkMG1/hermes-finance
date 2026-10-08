import SwiftUI

/// A labelled input whose error always renders directly under it.
struct Field<Input: View>: View {
    let label: String
    var error: String?
    @ViewBuilder var input: Input

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label).textStyle(.caption, color: Palette.secondaryText)
            input.textStyle(.body)
            InlineError(message: error)
        }
    }
}
