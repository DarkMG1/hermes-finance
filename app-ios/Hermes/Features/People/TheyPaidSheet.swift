import HermesKit
import SwiftUI

/// Log something a person paid that was partly yours. Your share becomes your own spending and their credit.
struct TheyPaidSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let person: Person
    let onDone: () async -> Void

    @State private var payee = ""
    @State private var date = Date.now
    @State private var categoryId: String?
    @State private var notes = ""
    @State private var totalText = ""
    @State private var justMineText = ""
    @State private var writes = WriteGuard()
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Sheet(
            title: "\(person.name) paid", saveTitle: "Add", canSave: request != nil, busy: busy, unresolved: writes.unresolved,
            onCancel: { if writes.unresolved { Task { await onDone() } }; dismiss() }, onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "What for") { TextField("Payee", text: $payee) }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                Field(label: "Total") { TextField("0.00", text: $totalText).keyboardType(.decimalPad) }
                Field(label: "Just mine") { TextField("0.00", text: $justMineText).keyboardType(.decimalPad) }
                NavigationLink { CategoryPicker(selection: $categoryId) } label: {
                    LabeledContent("Category", value: model.categoryName(categoryId))
                }
                Field(label: "Notes", error: error) { TextField("Notes", text: $notes, axis: .vertical).lineLimit(1...6) }
            } footer: {
                if let share, let total = Money.parse(totalText) {
                    Text("Your share: \(Money.format(share)) (\(Money.format(justMine ?? 0)) + half of \(Money.format(total - (justMine ?? 0))))")
                }
            }
            .disabled(writes.unresolved)
        }
    }

    private var justMine: Int? { justMineText.isEmpty ? 0 : Money.parse(justMineText) }

    private var share: Int? {
        guard let total = Money.parse(totalText), let justMine else { return nil }
        return SharedCost.yourShare(totalCents: total, justMineCents: justMine)
    }

    private var request: CreateTransactionBody? {
        let trimmed = payee.trimmingCharacters(in: .whitespaces)
        guard let share, share > 0, !trimmed.isEmpty else { return nil }
        return CreateTransactionBody(date: DayText.ymd(date), amountCents: -share, payee: trimmed, categoryId: categoryId,
                                     notes: notes.isEmpty ? nil : notes, paidByPersonId: person.id)
    }

    private func save() async {
        guard let client = model.client, let request else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.createTransaction(request, idempotencyKey: writes.key)
            writes.didSucceed()
            await onDone()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Add to retry; it won't be added twice." : errorMessage(error)
        }
    }
}
