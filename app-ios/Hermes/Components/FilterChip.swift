import SwiftUI

/// A capsule filter; accent when active. `showsMenu` adds the dropdown chevron Activity's menus use.
struct FilterChip: View {
    let title: String
    let active: Bool
    var showsMenu = false

    var body: some View {
        HStack(spacing: Space.xs) {
            Text(title).textStyle(.subhead, color: active ? Palette.background : Palette.text).lineLimit(1)
            if showsMenu {
                Image(systemName: "chevron.down").textStyle(.caption, color: active ? Palette.background : Palette.secondaryText)
            }
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, Space.s)
        .background(active ? Palette.accent : Palette.surface, in: Capsule())
    }
}
