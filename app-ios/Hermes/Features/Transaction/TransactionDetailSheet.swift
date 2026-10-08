import HermesKit
import SwiftUI

struct TransactionDetailSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let transaction: LedgerTransaction
    let onChange: () async -> Void

    @State private var payee = ""
    @State private var notes = ""
    @State private var categoryId: String?
    @State private var writes = WriteGuard()
    @State private var deleteWrites = WriteGuard()
    @State private var error: String?
    @State private var busy = false
    @State private var confirmDelete = false

    var body: some View {
        Sheet(
            title: "Transaction", canSave: !patch.isEmpty && !deleteWrites.unresolved, busy: busy,
            unresolved: writes.unresolved || deleteWrites.unresolved,
            onCancel: { dismiss() }, onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                LabeledContent("Amount") { MoneyText(cents: transaction.amountCents) }
                LabeledContent("Date", value: DayText.display(transaction.date))
                LabeledContent("Account", value: model.accountName(transaction.accountId))
                if transaction.pending { LabeledContent("Status", value: "Pending") }
                if !transaction.bankDescription.isEmpty { LabeledContent("Bank description", value: transaction.bankDescription) }
            }
            Section {
                Field(label: "Payee") { TextField("Payee", text: $payee) }
                if transaction.splitLines.isEmpty {
                    NavigationLink { CategoryPicker(selection: $categoryId) } label: {
                        LabeledContent("Category", value: model.categoryName(categoryId))
                    }
                }
                Field(label: "Notes", error: error) { TextField("Notes", text: $notes, axis: .vertical).lineLimit(1...6) }
            }
            .disabled(writes.unresolved || deleteWrites.unresolved)
            if !transaction.splitLines.isEmpty {
                Section("Split") {
                    ForEach(transaction.splitLines) { line in
                        ListRow(title: model.categoryName(line.categoryId), subtitle: line.notes) { MoneyText(cents: line.amountCents) }
                    }
                }
            }
            if transaction.source == "manual" {
                Section {
                    HButton(title: "Delete transaction", kind: .destructive, busy: busy) { confirmDelete = true }
                        .disabled(writes.unresolved)
                }
            }
        }
        .onAppear {
            payee = transaction.payee
            notes = transaction.notes ?? ""
            categoryId = transaction.categoryId
        }
        .confirmationDialog("Delete this transaction?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        }
    }

    private var patch: PatchTransactionBody {
        PatchTransactionBody(
            categoryId: categoryId != transaction.categoryId ? .set(categoryId) : .unchanged,
            payee: payee != transaction.payee ? .set(payee.isEmpty ? nil : payee) : .unchanged,
            notes: notes != (transaction.notes ?? "") ? .set(notes.isEmpty ? nil : notes) : .unchanged)
    }

    private func save() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.patchTransaction(id: transaction.id, body: patch, idempotencyKey: writes.key)
            writes.didSucceed()
            await onChange()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry." : errorMessage(error)
        }
    }

    private func delete() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.deleteTransaction(id: transaction.id, idempotencyKey: deleteWrites.key)
            deleteWrites.didSucceed()
            await onChange()
            dismiss()
        } catch {
            deleteWrites.didFail(error)
            self.error = deleteWrites.unresolved ? "Couldn't confirm the delete. Try again." : errorMessage(error)
        }
    }
}
