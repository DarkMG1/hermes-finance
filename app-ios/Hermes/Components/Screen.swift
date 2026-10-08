import SwiftUI

struct Screen<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) { content }
                .padding(Space.l)
        }
        .background(Palette.background)
        .navigationTitle(title)
    }
}
