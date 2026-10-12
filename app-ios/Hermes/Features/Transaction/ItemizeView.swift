import HermesKit
import SwiftUI

/// Claude reads the receipt into items; the owner says who had each one; saving rewrites the split
/// (own purchase) or sets the owner's share ("they paid" row).
struct ItemizeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let transaction: LedgerTransaction
    let onSaved: () async -> Void

    @State private var items: [DraftItem] = []
    @State private var taxText = ""
    @State private var tipText = ""
    @State private var feesText = ""
    @State private var handEdited = false
    @State private var loaded = false
    @State private var reading = false
    @State private var busy = false
    @State private var error: String?
    @State private var editing: DraftItem?
    @State private var confirmReread = false
    @State private var writes = WriteGuard()

    var body: some View {
        Sheet(title: "Itemize", canSave: canSave, busy: busy || reading || !loaded, unresolved: writes.unresolved,
              onCancel: { dismiss() }, onSave: { Task { await save() } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            if reading {
                Section { HStack { ProgressView(); Text("Reading receipt…").textStyle(.subhead, color: Palette.secondaryText) } }
            } else if loaded {
                if handEdited {
                    Section { Text("The split changed since these items were saved. Saving replaces it.").textStyle(.caption, color: Palette.secondaryText) }
                }
                Section("Items") {
                    ForEach(items) { item in
                        Button { editing = item } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(item.name).textStyle(.body)
                                    Text(item.people.map(label).joined(separator: ", ")).textStyle(.caption, color: Palette.secondaryText)
                                }
                                Spacer()
                                MoneyText(cents: item.amountCents)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { items.remove(atOffsets: $0) }
                    Button("Add item") { editing = DraftItem(id: UUID().uuidString, name: "", amountCents: 0, people: [ItemShares.me]) }
                }
                Section("Tax, tip and fees") {
                    Field(label: "Tax") { TextField("0.00", text: $taxText).keyboardType(.decimalPad) }
                    Field(label: "Tip") { TextField("0.00", text: $tipText).keyboardType(.decimalPad) }
                    Field(label: "Fees") { TextField("0.00", text: $feesText).keyboardType(.decimalPad) }
                    if !isTheyPaid, let result, result.gapCents != 0 {
                        LabeledContent("Tip and other (from bank)") { MoneyText(cents: result.gapCents) }
                    }
                }
                Section {
                    if let result {
                        ForEach(result.shares, id: \.person) { share in
                            LabeledContent(label(share.person)) { MoneyText(cents: share.cents) }
                        }
                    } else if !items.isEmpty {
                        Text("Every item needs someone, and each person's items must add up to more than zero.")
                            .textStyle(.caption, color: Palette.loss)
                    }
                    InlineError(message: error)
                } header: { Text("Shares") }
                Section {
                    Button("Read receipt again") { confirmReread = true }
                        .disabled(busy)
                        .confirmationDialog("Read the receipt again?", isPresented: $confirmReread, titleVisibility: .visible) {
                            Button("Read again", role: .destructive) { Task { await read() } }
                        } message: { Text("Replaces the items and who had them.") }
                }
            }
        }
        .sheet(item: $editing) { item in
            ItemEditSheet(item: item, choices: choices) { done in
                if let i = items.firstIndex(where: { $0.id == done.id }) { items[i] = done } else { items.append(done) }
            }
        }
        .task { await load() }
    }

    private var isTheyPaid: Bool { transaction.paidByPersonId != nil }

    /// Me first; on a "they paid" row only the payer, otherwise active people plus anyone already on an item.
    private var choices: [String] {
        if let payer = transaction.paidByPersonId { return [ItemShares.me, payer] }
        let active = model.people.filter { !$0.archived }.map(\.id)
        let onItems = items.flatMap(\.people).filter { $0 != ItemShares.me && !active.contains($0) }
        return [ItemShares.me] + active + Array(Set(onItems)).sorted()
    }

    private func label(_ person: String) -> String { person == ItemShares.me ? "Me" : model.personName(person) }

    private func cents(_ text: String) -> Int? { text.trimmingCharacters(in: .whitespaces).isEmpty ? 0 : Money.parse(text) }

    private var result: ItemShares.Result? {
        guard let tax = cents(taxText), let tip = cents(tipText), let fees = cents(feesText) else { return nil }
        let shareItems = items.map { ItemShares.Item(amountCents: $0.amountCents, people: $0.people) }
        let target = isTheyPaid ? items.reduce(0) { $0 + $1.amountCents } + tax + tip + fees : -transaction.amountCents
        return ItemShares.compute(items: shareItems, taxCents: tax, tipCents: tip, feesCents: fees, targetCents: target)
    }

    private var canSave: Bool {
        guard let result, !busy, !reading else { return false }
        // on a "they paid" row your share must be above zero
        return !isTheyPaid || (result.shares.first { $0.person == ItemShares.me }?.cents ?? 0) > 0
    }

    private func apply(_ it: Itemization) {
        items = it.items.map { DraftItem(id: $0.id, name: $0.name, amountCents: $0.amountCents, people: $0.people) }
        let text = { (c: Int?) in (c ?? 0) == 0 ? "" : Money.format(c ?? 0).replacingOccurrences(of: "$", with: "") }
        taxText = text(it.taxCents)
        tipText = text(it.tipCents)
        feesText = text(it.feesCents)
        handEdited = it.handEdited
    }

    private func load() async {
        guard !loaded, let client = model.client else { return }
        do {
            let it = try await client.receiptItems(transactionId: transaction.id)
            apply(it)
            loaded = true
            if it.readAt == nil { await read() }
        } catch {
            loaded = true
            self.error = errorMessage(error)
        }
    }

    private func read() async {
        guard let client = model.client else { return }
        reading = true
        defer { reading = false }
        error = nil
        do {
            apply(try await client.readReceipt(transactionId: transaction.id))
        } catch {
            // the list stays as it was (empty on a first read): items can be added by hand
            self.error = "\(errorMessage(error)) You can add the items by hand."
        }
    }

    private func save() async {
        guard let client = model.client, let tax = cents(taxText), let tip = cents(tipText), let fees = cents(feesText) else { return }
        busy = true
        defer { busy = false }
        error = nil
        let body = SaveItemsBody(items: items.map { .init(name: $0.name, amountCents: $0.amountCents, people: $0.people) },
                                 taxCents: tax, tipCents: tip, feesCents: fees)
        do {
            _ = try await client.saveReceiptItems(transactionId: transaction.id, body: body, idempotencyKey: writes.key)
            writes.didSucceed()
            await onSaved()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry; it won't be applied twice." : errorMessage(error)
        }
    }
}
