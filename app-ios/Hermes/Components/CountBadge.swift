import SwiftUI

/// A small count capsule, drawn inside its label's bounds so glass button animations don't clip it. Nothing at 0.
struct CountBadge: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text("\(count)").font(.caption2).foregroundStyle(.white)
                .padding(.horizontal, Space.xs).background(Palette.accent, in: Capsule())
        }
    }
}
