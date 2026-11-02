import HermesKit
import SwiftUI

struct TaxYearsView: View {
    @Environment(AppModel.self) private var model
    @State private var years: [TaxYears.Year]?
    @State private var error: String?

    var body: some View {
        List {
            InlineError(message: error)
            if let years {
                if years.isEmpty {
                    Text("Add a tax return or a W-2 with + on Financial profile.").textStyle(.subhead, color: Palette.secondaryText)
                }
                ForEach(years, id: \.year) { year in
                    Section(String(year.year)) {
                        if let rate = year.effectiveRate {
                            LabeledContent("Effective rate", value: rate.formatted(.percent.precision(.fractionLength(1))))
                        }
                        ForEach(year.returns) { r in
                            ListRow(title: r.jurisdiction == "federal" ? "Federal" : r.jurisdiction ?? "Return", subtitle: Self.summary(r.fields)) {
                                if let refund = r.refundCents {
                                    Text(refund < 0 ? "Owed \(Money.format(-refund))" : "Refund \(Money.format(refund))")
                                        .textStyle(.subhead, color: refund < 0 ? Palette.loss : Palette.gain)
                                }
                            }
                            .deleteSwipe("Delete this return?") { client, key in
                                try await client.deleteTaxReturn(id: r.id, idempotencyKey: key)
                                await load()
                            }
                        }
                        ForEach(year.forms) { TaxFormRow(form: $0) { await load() } }
                    }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .themedForm()
        .navigationTitle("Tax years")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            years = try await client.taxYears().years
            error = nil
        } catch {
            self.error = errorMessage(error)
        }
    }

    private static func summary(_ r: TaxReturnBody) -> String? {
        let parts = [r.totalIncomeCents.map { "Income \(Money.format($0))" }, r.totalTaxCents.map { "tax \(Money.format($0))" }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
