import HermesKit
import SwiftUI

struct MoneyText: View {
    let cents: Int
    var style: TextStyle = .body
    /// Money in shows in the gain colour.
    var colored = true
    /// For balances: a negative total shows in the loss colour.
    var negativeIsLoss = false

    var body: some View {
        Text(Money.format(cents)).textStyle(style, color: color).monospacedDigit()
    }

    private var color: Color {
        if negativeIsLoss && cents < 0 { return Palette.loss }
        return colored && cents > 0 ? Palette.gain : Palette.text
    }
}
