import HermesKit
import SwiftUI

struct InboxReceiptView: View {
    let receipt: InboxReceipt
    let onChange: () async -> Void
    var body: some View { Text(receipt.merchant ?? "Receipt") }
}
