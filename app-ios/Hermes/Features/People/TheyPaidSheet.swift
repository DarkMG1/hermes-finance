import HermesKit
import SwiftUI

/// Log a shared cost from a person's screen. They paid: one row for your share, paid by them.
/// I paid (`mePaid`): one row for the total, split into your share (with the category) and theirs (owed to you).
struct TheyPaidSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let person: Person
    var mePaid = false
    struct Prefill { let payee: String; let date: Date; let totalCents: Int? }
    var prefill: Prefill?
    var onCreated: ((LedgerTransaction) async -> Void)?
    let onDone: () async -> Void

    @State private var payee = ""
    @State private var date = Date.now
    @State private var categoryId: String?
    @State private var notes = ""
    @State private var totalText = ""
    @State private var justMineText = ""
    @State private var justTheirsText = ""
    @State private var writes = WriteGuard()
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Sheet(
            title: mePaid ? "I paid" : "\(person.name) paid", saveTitle: "Add", canSave: request != nil, busy: busy, unresolved: writes.unresolved,
            onCancel: { if writes.unresolved { Task { await onDone() } }; dismiss() }, onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "What for") { TextField("Payee", text: $payee) }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                Field(label: "Total") { TextField("0.00", text: $totalText).keyboardType(.decimalPad) }
                Field(label: "Just mine") { TextField("0.00", text: $justMineText).keyboardType(.decimalPad) }
                Field(label: "Just theirs") { TextField("0.00", text: $justTheirsText).keyboardType(.decimalPad) }
                NavigationLink { CategoryPicker(selection: $categoryId) } label: {
                    LabeledContent("Category", value: model.categoryName(categoryId))
                }
                NotesField(text: $notes, error: error)
            } footer: {
                if share == 0 && !mePaid {
                    Text("None of this is yours, so there's nothing to add.")
                } else if let share, let total = Money.parse(totalText) {
                    let shared = total - (justMine ?? 0) - (justTheirs ?? 0)
                    Text("Your share: \(Money.format(share)) (\(Money.format(justMine ?? 0)) + half of \(Money.format(shared)))")
                }
            }
            .disabled(writes.unresolved)
        }
        .onAppear {
            if let prefill, payee.isEmpty {
                payee = prefill.payee
                date = prefill.date
                totalText = prefill.totalCents.map { Money.format($0).replacingOccurrences(of: "$", with: "") } ?? ""
            }
        }
    }

    private var justMine: Int? { justMineText.isEmpty ? 0 : Money.parse(justMineText) }
    private var justTheirs: Int? { justTheirsText.isEmpty ? 0 : Money.parse(justTheirsText) }

    private var share: Int? {
        guard let total = Money.parse(totalText), let justMine, let justTheirs else { return nil }
        return SharedCost.yourShare(totalCents: total, justMineCents: justMine, justTheirsCents: justTheirs)
    }

    private var request: CreateTransactionBody? {
        let trimmed = payee.trimmingCharacters(in: .whitespaces)
        guard let share, !trimmed.isEmpty, let total = Money.parse(totalText) else { return nil }
        let note = notes.isEmpty ? nil : notes
        // I paid for something that is all theirs: one row they owe in full
        if mePaid && share == 0 {
            return CreateTransactionBody(date: DayText.ymd(date), amountCents: -total, payee: trimmed, categoryId: nil, notes: note, personId: person.id)
        }
        // they paid for something that is all theirs: nothing of it is yours to log
        guard share > 0 else { return nil }
        guard mePaid else {
            return CreateTransactionBody(date: DayText.ymd(date), amountCents: -share, payee: trimmed, categoryId: categoryId,
                                         notes: note, paidByPersonId: person.id)
        }
        // their share must be above zero, or there is nothing to split
        guard share < total else { return nil }
        return CreateTransactionBody(date: DayText.ymd(date), amountCents: -total, payee: trimmed, categoryId: nil, notes: note,
                                     splitLines: [SplitLineBody(amountCents: -share, categoryId: categoryId, notes: nil),
                                                  SplitLineBody(amountCents: -(total - share), categoryId: nil, notes: nil, personId: person.id)])
    }

    private func save() async {
        guard let client = model.client, let request else { return }
        busy = true
        defer { busy = false }
        do {
            let created = try await client.createTransaction(request, idempotencyKey: writes.key)
            writes.didSucceed()
            await onCreated?(created)
            await onDone()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Add to retry; it won't be added twice." : errorMessage(error)
        }
    }
}
