import HermesKit
import SwiftUI

/// Let go of some or all of what someone owes; the forgiven amount becomes your spending.
struct ForgiveSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let person: Person
    let onDone: () async -> Void

    @State private var amountText = ""
    @State private var date = Date.now
    @State private var categoryId: String?
    @State private var notes = ""
    @State private var writes = WriteGuard()
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Sheet(
            title: "Forgive", saveTitle: "Forgive", canSave: amount != nil, busy: busy, unresolved: writes.unresolved,
            onCancel: { if writes.unresolved { Task { await onDone() } }; dismiss() }, onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "Amount") {
                    HStack {
                        TextField("0.00", text: $amountText).keyboardType(.decimalPad)
                        Button("All") { amountText = owed }
                    }
                }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                NavigationLink { CategoryPicker(selection: $categoryId, noneTitle: "Gifts") } label: {
                    LabeledContent("Category", value: categoryId == nil ? "Gifts" : model.categoryName(categoryId))
                }
                NotesField(text: $notes, error: error)
            } footer: {
                if let amount {
                    let category = categoryId == nil ? "Gifts" : model.categoryName(categoryId)
                    Text("\(person.name) will owe \(Money.format(person.balanceCents - amount)). \(Money.format(amount)) counts as spending in \(category).")
                }
            }
            .disabled(busy || writes.unresolved)
        }
        .onAppear { if amountText.isEmpty { amountText = owed } }
    }

    private var owed: String { Money.format(person.balanceCents).replacingOccurrences(of: "$", with: "") }

    private var amount: Int? {
        guard let cents = Money.parse(amountText), cents > 0, cents <= person.balanceCents else { return nil }
        return cents
    }

    private func save() async {
        guard let client = model.client, let amount else { return }
        busy = true
        defer { busy = false }
        do {
            let body = ForgiveBody(amountCents: amount, date: DayText.ymd(date), categoryId: categoryId, notes: notes.isEmpty ? nil : notes)
            _ = try await client.forgive(personId: person.id, body: body, idempotencyKey: writes.key)
            writes.didSucceed()
            if categoryId == nil { await model.refreshReferenceData() }
            await onDone()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm. Tap Forgive to retry; it won't be applied twice." : errorMessage(error)
        }
    }
}
