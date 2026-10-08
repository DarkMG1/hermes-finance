import SwiftUI

struct HButton: View {
    enum Kind { case primary, secondary, destructive }

    let title: String
    var kind: Kind = .primary
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.s) {
                if busy { ProgressView() }
                Text(title).textStyle(.headline, color: foreground)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.m)
            .background(background, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private var foreground: Color {
        switch kind {
        case .primary: Palette.background
        case .secondary: Palette.accent
        case .destructive: Palette.loss
        }
    }

    private var background: Color { kind == .primary ? Palette.accent : Palette.surface }
}
