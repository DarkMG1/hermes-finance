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
    @State private var date = Date.now
    @State private var loadedDate = ""
    @State private var writes = WriteGuard()
    @State private var deleteWrites = WriteGuard()
    @State private var undoWrites = WriteGuard()
    @State private var error: String?
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var splitting: LedgerTransaction?
    @State private var savedForSplit = false
    @State private var itemizing = false
    @State private var savedFromItems = false
    @State private var reconciled = false
    @State private var reconciling = false
    @State private var reconcileError: String?
    @State private var receiptBusy = false
    /// A reconcile or receipt change saved straight away: closing must still refresh the list behind.
    @State private var savedOutside = false
    /// onAppear runs again when a full-screen cover (camera, receipt viewer) closes; fill the fields only once.
    @State private var loaded = false

    var body: some View {
        Sheet(
            title: "Transaction", canSave: !patch.isEmpty && !payeeInvalid && !deleteWrites.unresolved, busy: busy || reconciling || receiptBusy,
            unresolved: writes.unresolved || deleteWrites.unresolved || undoWrites.unresolved, dirty: !patch.isEmpty,
            onCancel: {
                if writes.unresolved || deleteWrites.unresolved || undoWrites.unresolved { Task { await onChange() } }
                dismiss()
            },
            onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                LabeledContent("Amount") { MoneyText(cents: transaction.amountCents) }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                    .disabled(busy || writes.unresolved || deleteWrites.unresolved)
                LabeledContent("Account", value: model.accountName(transaction.accountId))
                if transaction.pending { LabeledContent("Status", value: "Pending") }
                if !transaction.bankDescription.isEmpty { LabeledContent("Bank description", value: transaction.bankDescription) }
            }
            if !forgiven {
                Section {
                    Toggle("Reconciled", isOn: Binding(get: { reconciled }, set: { on in Task { await setReconciled(on) } }))
                        .disabled(busy || reconciling || deleteWrites.unresolved)
                    InlineError(message: reconcileError)
                }
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
                        NavigationLink { PersonPicker(selection: $paidById, noneTitle: "Me", title: "Paid by") } label: {
                            LabeledContent("Paid by", value: paidById.map(model.personName) ?? "Me")
                        }
                    }
                    if personId == nil {
                        NavigationLink { CategoryPicker(selection: $categoryId) } label: {
                            LabeledContent("Category", value: model.categoryName(categoryId))
                        }
                    }
                }
                NotesField(text: $notes, error: error)
            }
            .disabled(writes.unresolved || deleteWrites.unresolved)
            if !transaction.splitLines.isEmpty || canSplit {
                Section(transaction.splitLines.isEmpty ? "" : "Split") {
                    ForEach(transaction.splitLines) { line in
                        ListRow(
                            title: model.tagLabel(personId: line.personId, categoryId: line.categoryId, amountCents: line.amountCents), subtitle: line.notes
                        ) {
                            MoneyText(cents: line.amountCents)
                        }
                    }
                    if forgiven {
                        let name = transaction.splitLines.first?.personId.map(model.personName) ?? "them"
                        Text("Forgiveness for \(name). Delete it to change the amount.").textStyle(.caption, color: Palette.secondaryText)
                    }
                    if splitDrifted {
                        Text("The bank changed this amount, so the split no longer adds up. Edit the split to fix it.")
                            .textStyle(.caption, color: Palette.loss)
                    }
                    // unsaved edits would be lost when the split saves and this sheet closes, so the button saves them first
                    if canSplit {
                        Button(transaction.splitLines.isEmpty ? "Split transaction" : "Edit split") { Task { await split() } }
                            .disabled(busy || payeeInvalid || deleteWrites.unresolved)
                    }
                }
            }
            if !forgiven {
                Section("Receipt") {
                    ReceiptSection(transactionId: transaction.id, hadReceipt: transaction.hasReceipt ?? false, busy: $receiptBusy,
                                   onItemize: patch.isEmpty && transaction.amountCents < 0 ? { itemizing = true } : nil) { savedOutside = true }
                }
                .disabled(deleteWrites.unresolved)
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
            guard !loaded else { return }
            loaded = true
            payee = transaction.payee
            notes = transaction.notes ?? ""
            categoryId = transaction.categoryId
            personId = transaction.personId
            paidById = transaction.paidByPersonId
            date = DayText.date(transaction.date) ?? .now
            loadedDate = DayText.ymd(date)
            reconciled = transaction.reconciled ?? false
        }
        // a swipe-down skips onCancel, so the reconcile or receipt change refreshes the list here
        .onDisappear { if savedOutside { Task { await onChange() } } }
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
        .sheet(isPresented: $itemizing, onDismiss: {
            // the items save rewrote the split or the amount: this sheet's copy is stale, so close it
            if savedFromItems {
                busy = true
                Task { await onChange(); dismiss() }
            }
        }, content: {
            ItemizeView(transaction: transaction) { savedFromItems = true }
        })
    }

    private var splitDrifted: Bool {
        !transaction.splitLines.isEmpty && transaction.splitLines.reduce(0) { $0 + $1.amountCents } != transaction.amountCents
    }

    private var forgiven: Bool { transaction.forgiven == true }
    private var canSplit: Bool { transaction.paidByPersonId == nil && paidById == nil && !forgiven }
    private var trimmedPayee: String { payee.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var payeeInvalid: Bool { transaction.source == "manual" && trimmedPayee.isEmpty }

    private var patch: PatchTransactionBody {
        PatchTransactionBody(
            // a person clears the category on the server, so the category is only sent when nobody is chosen
            categoryId: personId == nil && categoryId != transaction.categoryId ? .set(categoryId) : .unchanged,
            payee: trimmedPayee != transaction.payee ? .set(trimmedPayee.isEmpty ? nil : trimmedPayee) : .unchanged,
            notes: notes != (transaction.notes ?? "") ? .set(notes.isEmpty ? nil : notes) : .unchanged,
            personId: personId != transaction.personId ? .set(personId) : .unchanged,
            paidByPersonId: paidById != transaction.paidByPersonId ? .set(paidById) : .unchanged,
            date: DayText.ymd(date) != loadedDate ? DayText.ymd(date) : nil)
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

    /// Saved at once. The server sets the state outright, so a retry with a fresh key is safe.
    private func setReconciled(_ on: Bool) async {
        guard let client = model.client else { return }
        let before = reconciled
        reconciled = on
        reconciling = true
        reconcileError = nil
        defer { reconciling = false }
        do {
            _ = try await client.setReconciled(id: transaction.id, reconciled: on, amountCents: on ? transaction.amountCents : nil,
                                               idempotencyKey: UUID().uuidString)
            savedOutside = true
        } catch {
            reconciled = before
            reconcileError = reconcileErrorMessage(error)
            // the bank changed the amount: the list behind is stale too
            if isAmountChanged(error) { savedOutside = true }
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
