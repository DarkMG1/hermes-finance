import SwiftUI
import UIKit

enum Palette {
    static let background = dynamic(light: 0xF5F2EC, dark: 0x141210)
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x1E1B18)
    static let text = dynamic(light: 0x1B2430, dark: 0xEFE9E1)
    static let secondaryText = dynamic(light: 0x1B2430, dark: 0xEFE9E1, alpha: 0.68)
    static let accent = dynamic(light: 0x9A5426, dark: 0xC97B4A)
    static let gain = dynamic(light: 0x2F7D4F, dark: 0x9CC28A)
    static let loss = dynamic(light: 0xB03A2E, dark: 0xE07B6A)
    static let separator = dynamic(light: 0x1B2430, dark: 0xEFE9E1, alpha: 0.12)

    private static func dynamic(light: UInt32, dark: UInt32, alpha: CGFloat = 1) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? uiColor(dark, alpha) : uiColor(light, alpha) })
    }

    private static func uiColor(_ hex: UInt32, _ alpha: CGFloat) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}
