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
    @State private var personId: String?
    @State private var paidById: String?
    @State private var writes = WriteGuard()
    @State private var deleteWrites = WriteGuard()
    @State private var undoWrites = WriteGuard()
    @State private var error: String?
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var splitting: LedgerTransaction?
    @State private var savedForSplit = false

    var body: some View {
        Sheet(
            title: "Transaction", canSave: !patch.isEmpty && !payeeInvalid && !deleteWrites.unresolved, busy: busy,
            unresolved: writes.unresolved || deleteWrites.unresolved || undoWrites.unresolved,
            onCancel: { if writes.unresolved || deleteWrites.unresolved { Task { await onChange() } }; dismiss() }, onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                LabeledContent("Amount") { MoneyText(cents: transaction.amountCents) }
                LabeledContent("Date", value: DayText.display(transaction.date))
                LabeledContent("Account", value: model.accountName(transaction.accountId))
                if transaction.pending { LabeledContent("Status", value: "Pending") }
                if !transaction.bankDescription.isEmpty { LabeledContent("Bank description", value: transaction.bankDescription) }
            }
            Section {
                Field(label: "Payee", error: payeeInvalid ? "Payee can't be empty" : nil) { TextField("Payee", text: $payee) }
                if transaction.splitLines.isEmpty {
                    if paidById == nil {
                        NavigationLink { PersonPicker(selection: $personId, noneTitle: noneTitle) } label: {
                            LabeledContent(transaction.amountCents < 0 ? "For" : "Repaid by", value: personId.map(model.personName) ?? noneTitle)
                        }
                    }
                    // someone else paid this manual expense: it stays your spending, and counts as their credit
                    if canHavePayer && personId == nil {
                        NavigationLink { PersonPicker(selection: $paidById, noneTitle: "Me") } label: {
                            LabeledContent("Paid by", value: paidById.map(model.personName) ?? "Me")
                        }
                    }
                    if personId == nil {
                        NavigationLink { CategoryPicker(selection: $categoryId) } label: {
                            LabeledContent("Category", value: model.categoryName(categoryId))
                        }
                    }
                }
                Field(label: "Notes", error: error) { TextField("Notes", text: $notes, axis: .vertical).lineLimit(1...6) }
            }
            .disabled(writes.unresolved || deleteWrites.unresolved)
            Section(transaction.splitLines.isEmpty ? "" : "Split") {
                ForEach(transaction.splitLines) { line in
                    ListRow(title: model.tagLabel(personId: line.personId, categoryId: line.categoryId, amountCents: line.amountCents), subtitle: line.notes) {
                        MoneyText(cents: line.amountCents)
                    }
                }
                if splitDrifted {
                    Text("The bank changed this amount, so the split no longer adds up. Edit the split to fix it.")
                        .textStyle(.caption, color: Palette.loss)
                }
                // unsaved edits would be lost when the split saves and this sheet closes, so the button saves them first
                if transaction.paidByPersonId == nil && paidById == nil {
                    Button(transaction.splitLines.isEmpty ? "Split transaction" : "Edit split") { Task { await split() } }
                        .disabled(busy || payeeInvalid || deleteWrites.unresolved)
                }
            }
            if transaction.repaymentDismissed == true {
                Section {
                    Text("Hidden from repayment suggestions").textStyle(.subhead, color: Palette.secondaryText)
                    HButton(title: "Undo", busy: busy) { Task { await undoDismiss() } }
                        .disabled(writes.unresolved || deleteWrites.unresolved)
                }
            }
            if transaction.source == "manual" {
                Section {
                    HButton(title: "Delete transaction", kind: .destructive, busy: busy) { confirmDelete = true }
                        .disabled(writes.unresolved)
                        .confirmationDialog("Delete this transaction?", isPresented: $confirmDelete, titleVisibility: .visible) {
                            Button("Delete", role: .destructive) { Task { await delete() } }
                        }
                }
            }
        }
        .onAppear {
            payee = transaction.payee
            notes = transaction.notes ?? ""
            categoryId = transaction.categoryId
            personId = transaction.personId
            paidById = transaction.paidByPersonId
        }
        .sheet(item: $splitting, onDismiss: {
            // the edits were saved but the split was cancelled: this sheet's copy is stale, so close it
            if savedForSplit {
                busy = true
                Task { await onChange(); dismiss() }
            }
        }, content: { saved in
            SplitSheet(transaction: saved) {
                savedForSplit = false
                await onChange()
                dismiss()
            }
        })
    }

    private var splitDrifted: Bool {
        !transaction.splitLines.isEmpty && transaction.splitLines.reduce(0) { $0 + $1.amountCents } != transaction.amountCents
    }

    private var trimmedPayee: String { payee.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var payeeInvalid: Bool { transaction.source == "manual" && trimmedPayee.isEmpty }

    private var patch: PatchTransactionBody {
        PatchTransactionBody(
            // a person clears the category on the server, so the category is only sent when nobody is chosen
            categoryId: personId == nil && categoryId != transaction.categoryId ? .set(categoryId) : .unchanged,
            payee: trimmedPayee != transaction.payee ? .set(trimmedPayee.isEmpty ? nil : trimmedPayee) : .unchanged,
            notes: notes != (transaction.notes ?? "") ? .set(notes.isEmpty ? nil : notes) : .unchanged,
            personId: personId != transaction.personId ? .set(personId) : .unchanged,
            paidByPersonId: paidById != transaction.paidByPersonId ? .set(paidById) : .unchanged)
    }

    private var noneTitle: String { transaction.amountCents < 0 ? "Me" : "Nobody" }

    private var canHavePayer: Bool { transaction.source == "manual" && transaction.amountCents < 0 }

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

    private func split() async {
        guard !patch.isEmpty else { splitting = transaction; return }
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            let saved = try await client.patchTransaction(id: transaction.id, body: patch, idempotencyKey: writes.key)
            writes.didSucceed()
            savedForSplit = true
            splitting = saved
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Try again." : errorMessage(error)
        }
    }

    private func undoDismiss() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.patchTransaction(id: transaction.id, body: PatchTransactionBody(repaymentDismissed: false),
                                                  idempotencyKey: undoWrites.key)
            undoWrites.didSucceed()
            await onChange()
            dismiss()
        } catch {
            undoWrites.didFail(error)
            self.error = undoWrites.unresolved ? "Couldn't confirm. Try again." : errorMessage(error)
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
