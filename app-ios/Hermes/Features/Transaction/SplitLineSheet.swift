import HermesKit
import SwiftUI

/// One line of a split: its own name, person, category and notes. Its amount changes through Edit split, which
/// opens the whole split from either line.
struct SplitLineSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let transaction: LedgerTransaction
    let lineId: String
    let onChange: () async -> Void

    @State private var name = ""
    @State private var notes = ""
    @State private var categoryId: String?
    @State private var personId: String?
    @State private var writes = WriteGuard()
    @State private var error: String?
    @State private var busy = false
    @State private var splitting: LedgerTransaction?
    @State private var savedForSplit = false

    private var line: SplitLine? { transaction.splitLines.first { $0.id == lineId } }

    var body: some View {
        Sheet(
            title: "Transaction", canSave: line != nil && !patch.isEmpty, busy: busy, unresolved: writes.unresolved,
            onCancel: { if writes.unresolved { Task { await onChange() } }; dismiss() },
            onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            if let line {
                Section {
                    LabeledContent("Amount") { MoneyText(cents: line.amountCents) }
                    LabeledContent("Date", value: DayText.display(transaction.date))
                    LabeledContent("Account", value: model.accountName(transaction.accountId))
                    if transaction.pending { LabeledContent("Status", value: "Pending") }
                    if !transaction.bankDescription.isEmpty { LabeledContent("Bank description", value: transaction.bankDescription) }
                }
                Section {
                    // blank shows the transaction's payee
                    Field(label: "Payee") { TextField(transaction.payee, text: $name) }
                    NavigationLink { PersonPicker(selection: $personId) } label: {
                        LabeledContent("For", value: personId.map(model.personName) ?? "Me")
                    }
                    if personId == nil {
                        NavigationLink { CategoryPicker(selection: $categoryId) } label: {
                            LabeledContent("Category", value: model.categoryName(categoryId))
                        }
                    }
                    Field(label: "Notes", error: error) { TextField("Notes", text: $notes, axis: .vertical).lineLimit(1...6) }
                }
                .disabled(writes.unresolved || busy)
                Section {
                    // unsaved edits would be lost when the split saves and this sheet closes, so the button saves them first
                    Button("Edit split") { Task { await editSplit() } }
                        .disabled(busy)
                }
            } else {
                // the split was saved again elsewhere, which gives every line a new id
                Section { Text("This line changed. Close and refresh.").textStyle(.subhead, color: Palette.secondaryText) }
            }
        }
        .onAppear {
            name = line?.payee ?? ""
            notes = line?.notes ?? ""
            categoryId = line?.categoryId
            personId = line?.personId
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

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var patch: PatchSplitLineBody {
        guard let line else { return PatchSplitLineBody() }
        return PatchSplitLineBody(
            payee: trimmedName != (line.payee ?? "") ? .set(trimmedName.isEmpty ? nil : trimmedName) : .unchanged,
            // a person clears the category on the server, so the category is only sent when nobody is chosen
            categoryId: personId == nil && categoryId != line.categoryId ? .set(categoryId) : .unchanged,
            personId: personId != line.personId ? .set(personId) : .unchanged,
            notes: notes != (line.notes ?? "") ? .set(notes.isEmpty ? nil : notes) : .unchanged)
    }

    private func save() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.patchSplitLine(transactionId: transaction.id, lineId: lineId, body: patch, idempotencyKey: writes.key)
            writes.didSucceed()
            await onChange()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry." : errorMessage(error)
        }
    }

    private func editSplit() async {
        guard !patch.isEmpty else { splitting = transaction; return }
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            let saved = try await client.patchSplitLine(transactionId: transaction.id, lineId: lineId, body: patch, idempotencyKey: writes.key)
            writes.didSucceed()
            savedForSplit = true
            splitting = saved
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Try again." : errorMessage(error)
        }
    }
}
