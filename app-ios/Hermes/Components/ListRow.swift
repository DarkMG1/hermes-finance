import SwiftUI

struct ListRow<Trailing: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: Space.m) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).textStyle(.body).lineLimit(1)
                if let subtitle { Text(subtitle).textStyle(.caption, color: Palette.secondaryText).lineLimit(1) }
            }
            Spacer(minLength: Space.s)
            trailing
        }
        .padding(.vertical, Space.xs)
        .contentShape(Rectangle())
    }
}

extension ListRow where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}
