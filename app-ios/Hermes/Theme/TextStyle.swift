import SwiftUI

enum TextStyle {
    case display, title, headline, body, subhead, caption

    var font: Font {
        switch self {
        case .display: .system(.largeTitle, design: .rounded).weight(.bold)
        case .title: .title2.weight(.semibold)
        case .headline: .headline
        case .body: .body
        case .subhead: .subheadline
        case .caption: .caption
        }
    }
}

extension View {
    func textStyle(_ style: TextStyle, color: Color = Palette.text) -> some View {
        font(style.font).foregroundStyle(color)
    }

    func themedForm() -> some View {
        scrollContentBackground(.hidden).background(Palette.background)
    }
}
