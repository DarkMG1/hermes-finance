import HermesKit
import SwiftUI

/// Divide a transaction into lines with their own category. Amounts are typed as positive numbers and take the
/// transaction's sign; Save needs two or more lines that add up exactly.
struct SplitSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let transaction: LedgerTransaction
    let onDone: () async -> Void

    private struct Line: Identifiable {
        let id = UUID()
        var amount = ""
        var categoryId: String?
        var notes = ""
    }

    @State private var lines: [Line] = []
    @State private var writes = WriteGuard()
    @State private var removeWrites = WriteGuard()
    @State private var error: String?
    @State private var busy = false
    @State private var confirmRemove = false

    var body: some View {
        Sheet(
            title: "Split", canSave: SplitMath.isComplete(total: transaction.amountCents, amounts: amounts) && !removeWrites.unresolved,
            busy: busy, unresolved: writes.unresolved || removeWrites.unresolved,
            onCancel: { if writes.unresolved || removeWrites.unresolved { Task { await onDone() } }; dismiss() }, onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                LabeledContent("Total") { MoneyText(cents: transaction.amountCents) }
                LabeledContent("Left to assign") { Text(Money.format(remaining)).monospacedDigit() }
            }
            ForEach($lines) { $line in
                Section {
                    Field(label: "Amount") { TextField("0.00", text: $line.amount).keyboardType(.decimalPad) }
                    NavigationLink { CategoryPicker(selection: $line.categoryId) } label: {
                        LabeledContent("Category", value: model.categoryName(line.categoryId))
                    }
                    Field(label: "Notes") { TextField("Notes", text: $line.notes) }
                    if lines.count > 2 {
                        Button("Remove line", role: .destructive) { lines.removeAll { $0.id == line.id } }
                    }
                }
            }
            .disabled(writes.unresolved || removeWrites.unresolved)
            Section {
                Button("Add line") { lines.append(Line(amount: remaining > 0 ? plain(remaining) : "")) }
                    .disabled(lines.count >= 20 || writes.unresolved || removeWrites.unresolved)
                InlineError(message: error)
            }
            if !transaction.splitLines.isEmpty {
                Section {
                    HButton(title: "Remove split", kind: .destructive, busy: busy) { confirmRemove = true }
                        .disabled(writes.unresolved)
                }
            }
        }
        .onAppear(perform: start)
        .confirmationDialog("Remove the split? The transaction becomes uncategorized.", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove split", role: .destructive) { Task { await remove() } }
        }
    }

    private var amounts: [String] { lines.map(\.amount) }

    private var remaining: Int { SplitMath.remaining(total: transaction.amountCents, amounts: amounts) }

    /// "12.45" for 1245 cents: editable text, no currency symbol or separators.
    private func plain(_ cents: Int) -> String { String(format: "%d.%02d", cents / 100, cents % 100) }

    private func start() {
        guard lines.isEmpty else { return }
        if transaction.splitLines.isEmpty {
            lines = [Line(amount: plain(abs(transaction.amountCents)), categoryId: transaction.categoryId), Line()]
        } else {
            lines = transaction.splitLines.map { Line(amount: plain(abs($0.amountCents)), categoryId: $0.categoryId, notes: $0.notes ?? "") }
        }
    }

    private func save() async {
        guard let cents = SplitMath.cents(total: transaction.amountCents, amounts: amounts) else { return }
        let body = PutSplitsBody(lines: zip(cents, lines).map { amount, line in
            let notes = line.notes.trimmingCharacters(in: .whitespacesAndNewlines)
            return .init(amountCents: amount, categoryId: line.categoryId, notes: notes.isEmpty ? nil : notes)
        })
        await write(body, guard: $writes)
    }

    private func remove() async { await write(PutSplitsBody(lines: []), guard: $removeWrites) }

    private func write(_ body: PutSplitsBody, guard writeGuard: Binding<WriteGuard>) async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.putSplits(transactionId: transaction.id, body: body, idempotencyKey: writeGuard.wrappedValue.key)
            writeGuard.wrappedValue.didSucceed()
            await onDone()
            dismiss()
        } catch {
            writeGuard.wrappedValue.didFail(error)
            self.error = writeGuard.wrappedValue.unresolved ? "Couldn't confirm the save. Try again." : errorMessage(error)
        }
    }
}
