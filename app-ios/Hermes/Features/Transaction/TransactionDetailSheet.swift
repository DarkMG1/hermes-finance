import HermesKit
import SwiftUI

struct TransactionDetailSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let transaction: LedgerTransaction
    /// False when opened from History itself, so sheets don't stack without end.
    var showsHistory = true
    /// Other charges edited from History, for a list that refreshes rows one by one; the rest reload whole on onChange.
    var onOthersChange: ((Set<String>) async -> Void)?
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
    @State private var markingRecurring = false
    /// Set by a mark here, so the sheet shows the new bill without reopening.
    @State private var marked: TransactionRecurring?
    @State private var recurringBusy = false
    @State private var recurringWrites = WriteGuard()
    /// The frequency an unconfirmed mark sent: the retry resends it under the same key.
    @State private var markFrequency = ""
    @State private var recurringError: String?
    @State private var reconciled = false
    @State private var reconciling = false
    @State private var reconcileError: String?
    @State private var receiptBusy = false
    /// A reconcile or receipt change saved straight away: closing must still refresh the list behind.
    @State private var savedOutside = false
    @State private var othersChanged: Set<String> = []
    /// onAppear runs again when a full-screen cover (camera, receipt viewer) closes; fill the fields only once.
    @State private var loaded = false
    /// Reloaded after the payback picker saves, so the row shows the new links without reopening.
    @State private var iou: TransactionIOU?
    @State private var paying: PaybackTarget?
    /// The picker opened right after Save tagged this deposit: the sheet closes with it.
    @State private var closeAfterPaying = false
    /// The saved copy when the sheet stays open after Save (the open-items read failed).
    @State private var afterSave: LedgerTransaction?

    var body: some View {
        Sheet(
            title: "Transaction", canSave: !patch.isEmpty && !payeeInvalid && !deleteWrites.unresolved,
            busy: busy || reconciling || receiptBusy || recurringBusy, unresolved: unresolved, dirty: !patch.isEmpty,
            onCancel: {
                if unresolved { Task { await onChange() } }
                dismiss()
            },
            onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                LabeledContent("Amount") { MoneyText(cents: current.amountCents) }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                    .disabled(busy || writes.unresolved || deleteWrites.unresolved)
                LabeledContent("Account", value: model.accountName(current.accountId))
                if current.pending { LabeledContent("Status", value: "Pending") }
                if !current.bankDescription.isEmpty { LabeledContent("Bank description", value: current.bankDescription) }
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
                // the saved payee, not the text being typed
                if showsHistory && (current.hasHistory == true || bill != nil) {
                    NavigationLink {
                        PayeeHistoryView(match: bill.map { [URLQueryItem(name: "recurringId", value: $0.id)] }
                                         ?? [URLQueryItem(name: "name", value: current.payee)]
                                         + (current.bankDescription.isEmpty ? [] : [URLQueryItem(name: "bank", value: current.bankDescription)]),
                                         title: bill?.name ?? current.payee) { ids in
                            othersChanged.formUnion(ids.subtracting([current.id]))
                            // this sheet's own charge changed there: its copy is stale, so close it rather than let it save over
                            if ids.contains(current.id) { busy = true; await onChange(); dismiss() } else { savedOutside = true }
                        }
                    } label: { Text("History") }
                }
                if current.splitLines.isEmpty {
                    if paidById == nil {
                        NavigationLink { PersonPicker(selection: $personId, noneTitle: noneTitle) } label: {
                            LabeledContent(current.amountCents < 0 ? "For" : "Repaid by", value: personId.map(model.personName) ?? noneTitle)
                        }
                        // the saved person's links; hidden while another person is picked but not saved
                        if current.amountCents > 0, let saved = current.personId, personId == saved, let iou {
                            Button { paying = paybackTarget(saved) } label: { LabeledContent("Paying back", value: paybackLabel(iou)) }
                                .foregroundStyle(Palette.text)
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
            if !current.splitLines.isEmpty || canSplit {
                Section(current.splitLines.isEmpty ? "" : "Split") {
                    ForEach(current.splitLines) { line in
                        ListRow(
                            title: model.tagLabel(personId: line.personId, categoryId: line.categoryId, amountCents: line.amountCents), subtitle: line.notes
                        ) {
                            MoneyText(cents: line.amountCents)
                        }
                    }
                    if forgiven {
                        let name = current.splitLines.first?.personId.map(model.personName) ?? "them"
                        Text("Forgiveness for \(name). Delete it to change the amount.").textStyle(.caption, color: Palette.secondaryText)
                    }
                    if splitDrifted {
                        Text("The bank changed this amount, so the split no longer adds up. Edit the split to fix it.")
                            .textStyle(.caption, color: Palette.loss)
                    }
                    // unsaved edits would be lost when the split saves and this sheet closes, so the button saves them first
                    if canSplit {
                        Button(current.splitLines.isEmpty ? "Split transaction" : "Edit split") { Task { await split() } }
                            .disabled(busy || payeeInvalid || deleteWrites.unresolved)
                    }
                }
            }
            if !forgiven {
                Section("Receipt") {
                    ReceiptSection(transactionId: current.id, hadReceipt: current.hasReceipt ?? false, busy: $receiptBusy,
                                   onItemize: patch.isEmpty && current.amountCents < 0 ? { itemizing = true } : nil) { savedOutside = true }
                }
                .disabled(deleteWrites.unresolved)
            }
            if let bill {
                Section { Text("Recurring · \(RecurringFrequency.label(bill.frequency))") }
            } else if current.canMarkRecurring {
                Section {
                    // dialog on its button: on the Form it floats mid-screen
                    Button("Mark as recurring…") {
                        if recurringWrites.unresolved { Task { await markRecurring(markFrequency) } } else { markingRecurring = true }
                    }
                        .disabled(recurringBusy)
                        .confirmationDialog("How often?", isPresented: $markingRecurring, titleVisibility: .visible) {
                            ForEach(RecurringFrequency.writable, id: \.self) { frequency in
                                Button(RecurringFrequency.label(frequency)) { Task { await markRecurring(frequency) } }
                            }
                        }
                    InlineError(message: recurringError)
                }
            }
            if current.repaymentDismissed == true {
                Section {
                    Text("Hidden from repayment suggestions").textStyle(.subhead, color: Palette.secondaryText)
                    HButton(title: "Undo", busy: busy) { Task { await undoDismiss() } }
                        .disabled(writes.unresolved || deleteWrites.unresolved)
                }
            }
            if current.source == "manual" {
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
            fill(transaction)
        }
        // a swipe-down skips onCancel, so the reconcile or receipt change refreshes the list here
        .onDisappear {
            let outside = savedOutside, others = othersChanged
            guard outside || !others.isEmpty else { return }
            // a full-screen cover opening fires this too; the close mustn't refresh the same changes again
            savedOutside = false
            othersChanged = []
            Task {
                if outside { await onChange() }
                if !others.isEmpty { await onOthersChange?(others) }
            }
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
        .sheet(item: $paying, onDismiss: { if closeAfterPaying { dismiss() } }, content: { target in
            PaybackPicker(transactionId: target.transactionId, lineId: nil, personId: target.personId,
                          paybackCents: target.paybackCents) { await reloadIOU() }
        })
        .sheet(isPresented: $itemizing, onDismiss: {
            // the items save rewrote the split or the amount: this sheet's copy is stale, so close it
            if savedFromItems {
                busy = true
                Task { await onChange(); dismiss() }
            }
        }, content: {
            ItemizeView(transaction: current) { savedFromItems = true }
        })
    }

    private var splitDrifted: Bool {
        !current.splitLines.isEmpty && current.splitLines.reduce(0) { $0 + $1.amountCents } != current.amountCents
    }

    private var current: LedgerTransaction { afterSave ?? transaction }

    private func fill(_ transaction: LedgerTransaction) {
        payee = transaction.payee
        notes = transaction.notes ?? ""
        categoryId = transaction.categoryId
        personId = transaction.personId
        paidById = transaction.paidByPersonId
        date = DayText.date(transaction.date) ?? .now
        loadedDate = DayText.ymd(date)
        reconciled = transaction.reconciled ?? false
        iou = transaction.iou
    }

    private var forgiven: Bool { current.forgiven == true }
    private var bill: TransactionRecurring? { marked ?? current.recurring }
    private var unresolved: Bool { writes.unresolved || deleteWrites.unresolved || undoWrites.unresolved || recurringWrites.unresolved }
    private var canSplit: Bool { current.paidByPersonId == nil && paidById == nil && !forgiven }
    private var trimmedPayee: String { payee.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var payeeInvalid: Bool { current.source == "manual" && trimmedPayee.isEmpty }

    private var patch: PatchTransactionBody {
        PatchTransactionBody(
            // a person clears the category on the server, so the category is only sent when nobody is chosen
            categoryId: personId == nil && categoryId != current.categoryId ? .set(categoryId) : .unchanged,
            payee: trimmedPayee != current.payee ? .set(trimmedPayee.isEmpty ? nil : trimmedPayee) : .unchanged,
            notes: notes != (current.notes ?? "") ? .set(notes.isEmpty ? nil : notes) : .unchanged,
            personId: personId != current.personId ? .set(personId) : .unchanged,
            paidByPersonId: paidById != current.paidByPersonId ? .set(paidById) : .unchanged,
            date: DayText.ymd(date) != loadedDate ? DayText.ymd(date) : nil)
    }

    private func paybackLabel(_ iou: TransactionIOU) -> String {
        switch iou.paidBack.count {
        case 0: "Just the balance"
        case 1: iou.paidBack[0].payee ?? "1 item"
        case let n: "\(n) items"
        }
    }

    private func paybackTarget(_ personId: String) -> PaybackTarget {
        PaybackTarget(transactionId: current.id, lineId: nil, personId: personId, paybackCents: current.amountCents)
    }

    private func reloadIOU() async {
        savedOutside = true
        guard let reader = model.reader else { return }
        do {
            iou = try await reader.read("/v1/transactions/\(current.id)", as: LedgerTransaction.self).value.iou
            error = nil
        } catch {
            self.error = "Couldn't refresh what this pays back: \(errorMessage(error))"
        }
    }

    private var noneTitle: String { current.amountCents < 0 ? "Me" : "Nobody" }

    private var canHavePayer: Bool { current.source == "manual" && current.amountCents < 0 }

    private func save() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        // a deposit newly tagged to someone goes on to what it paid back, like a confirmed repayment suggestion
        let paidBy = current.amountCents > 0 && current.splitLines.isEmpty && personId != current.personId ? personId : nil
        do {
            let saved = try await client.patchTransaction(id: current.id, body: patch, idempotencyKey: writes.key)
            writes.didSucceed()
            await onChange()
            guard let target = paidBy.map(paybackTarget) else { return dismiss() }
            do {
                guard let choices = try await model.paybackChoices(target), !choices.items.isEmpty else { return dismiss() }
                closeAfterPaying = true
                paying = target
            } catch {
                // the tag is saved: stay open on it, and the Paying back row is the retry
                afterSave = saved
                fill(saved)
                self.error = "Saved. Couldn't load open items — use Paying back to link them."
            }
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry." : errorMessage(error)
        }
    }

    private func split() async {
        guard !patch.isEmpty else { splitting = current; return }
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            let saved = try await client.patchTransaction(id: current.id, body: patch, idempotencyKey: writes.key)
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
            _ = try await client.setReconciled(id: current.id, reconciled: on, amountCents: on ? current.amountCents : nil,
                                               idempotencyKey: UUID().uuidString)
            savedOutside = true
        } catch {
            reconciled = before
            reconcileError = reconcileErrorMessage(error)
            // the bank changed the amount: the list behind is stale too
            if isAmountChanged(error) { savedOutside = true }
        }
    }

    private func markRecurring(_ frequency: String) async {
        guard !recurringBusy, current.canMarkRecurring, let client = model.client else { return }
        recurringBusy = true
        defer { recurringBusy = false }
        recurringError = nil
        markFrequency = frequency
        do {
            let item = try await client.createRecurring(body: CreateRecurringBody(transactionId: current.id, frequency: frequency, name: nil),
                                                        idempotencyKey: recurringWrites.key)
            recurringWrites.didSucceed()
            marked = TransactionRecurring(id: item.id, name: item.name, frequency: item.frequency)
            // the row behind now belongs to a bill; it refreshes when this sheet closes, like a reconcile
            savedOutside = true
        } catch {
            recurringWrites.didFail(error)
            recurringError = recurringWrites.unresolved ? "Couldn't confirm the save. Try again." : errorMessage(error)
        }
    }

    private func undoDismiss() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.patchTransaction(id: current.id, body: PatchTransactionBody(repaymentDismissed: false),
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
            try await client.deleteTransaction(id: current.id, idempotencyKey: deleteWrites.key)
            deleteWrites.didSucceed()
            await onChange()
            dismiss()
        } catch {
            deleteWrites.didFail(error)
            self.error = deleteWrites.unresolved ? "Couldn't confirm the delete. Try again." : errorMessage(error)
        }
    }
}
