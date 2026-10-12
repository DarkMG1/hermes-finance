import HermesKit
import SwiftUI

struct MoneyText: View {
    @Environment(\.redactionReasons) private var redaction
    let cents: Int
    var style: TextStyle = .body
    /// Money in shows in the gain colour.
    var colored = true
    /// For balances: a negative total shows in the loss colour.
    var negativeIsLoss = false

    var body: some View {
        Text(Money.format(cents)).textStyle(style, color: color).monospacedDigit()
            .accessibilityLabel(!redaction.isEmpty ? "Hidden" : cents < 0 ? "minus " + Money.format(-cents) : Money.format(cents))
    }

    private var color: Color {
        if negativeIsLoss && cents < 0 { return Palette.loss }
        return colored && cents > 0 ? Palette.gain : Palette.text
    }
}

extension EnvironmentValues {
    /// A screen's own eye button showed its amounts while balances stay hidden elsewhere (Investments and the holdings opened from it).
    @Entry var balancesRevealed = false
}
