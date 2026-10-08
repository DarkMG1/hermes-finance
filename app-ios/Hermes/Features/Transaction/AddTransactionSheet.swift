import HermesKit
import SwiftUI

struct AddTransactionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onChange: () async -> Void

    @State private var isExpense = true
    @State private var amountText = ""
    @State private var payee = ""
    @State private var accountId: String?
    @State private var date = Date.now
    @State private var categoryId: String?
    @State private var notes = ""
    @State private var writes = WriteGuard()
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Sheet(
            title: "Add transaction", saveTitle: "Add", canSave: request != nil, busy: busy, unresolved: writes.unresolved,
            onCancel: { dismiss() }, onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Picker("Type", selection: $isExpense) {
                    Text("Expense").tag(true)
                    Text("Income").tag(false)
                }
                .pickerStyle(.segmented)
                Field(label: "Amount", error: amountError) { TextField("0.00", text: $amountText).keyboardType(.decimalPad) }
                Field(label: "Payee") { TextField("Payee", text: $payee) }
                Picker("Account", selection: $accountId) {
                    Text("Choose…").tag(String?.none)
                    ForEach(model.accounts.filter { !$0.hidden }) { account in Text(account.name).tag(Optional(account.id)) }
                }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                NavigationLink { CategoryPicker(selection: $categoryId) } label: {
                    LabeledContent("Category", value: model.categoryName(categoryId))
                }
                Field(label: "Notes", error: error) { TextField("Notes", text: $notes, axis: .vertical).lineLimit(1...6) }
            }
            .disabled(writes.unresolved)
        }
    }

    private var amountError: String? {
        guard !amountText.isEmpty else { return nil }
        guard let cents = Money.parse(amountText) else { return "Enter an amount like 12.34" }
        return cents == 0 ? "Amount can't be zero" : nil
    }

    private var request: CreateTransactionBody? {
        guard let cents = Money.parse(amountText), cents > 0, let accountId else { return nil }
        let trimmedPayee = payee.trimmingCharacters(in: .whitespaces)
        guard !trimmedPayee.isEmpty else { return nil }
        return CreateTransactionBody(accountId: accountId, date: DayText.ymd(date), amountCents: isExpense ? -cents : cents,
                                     payee: trimmedPayee, categoryId: categoryId, notes: notes.isEmpty ? nil : notes)
    }

    private func save() async {
        guard let client = model.client, let request else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.createTransaction(request, idempotencyKey: writes.key)
            writes.didSucceed()
            await onChange()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Add to retry; it won't be added twice." : errorMessage(error)
        }
    }
}
