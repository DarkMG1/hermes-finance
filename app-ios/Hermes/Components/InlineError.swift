import SwiftUI

struct InlineError: View {
    let message: String?

    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.circle").textStyle(.caption, color: Palette.loss)
        }
    }
}
