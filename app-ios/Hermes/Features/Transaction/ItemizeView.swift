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
    @State private var loading = false
    @State private var loadError: String?
    @State private var reading = false
    @State private var busy = false
    @State private var error: String?
    @State private var editing: DraftItem?
    @State private var confirmReread = false
    @State private var writes = WriteGuard()

    var body: some View {
        Sheet(title: "Itemize", canSave: canSave, busy: busy || reading || loading, unresolved: writes.unresolved, onCancel: {
            // the save may have landed: the detail sheet refreshes and closes, as it does after a confirmed save
            if writes.unresolved { Task { await onSaved() } }
            dismiss()
        }, onSave: { Task { await save() } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            if reading {
                Section { HStack { ProgressView(); Text("Reading receipt…").textStyle(.subhead, color: Palette.secondaryText) } }
            } else if let loadError {
                Section {
                    InlineError(message: loadError)
                    Button("Try again") { Task { await load() } }
                }
            } else if loaded {
                if handEdited {
                    Section {
                        Text("This transaction changed since these items were saved. Saving replaces it.").textStyle(.caption, color: Palette.secondaryText)
                    }
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
                                MoneyText(cents: item.amountCents, colored: false)
                            }
                        }
                        .buttonStyle(.plain)
                        .deleteDisabled(locked)
                    }
                    .onDelete { items.remove(atOffsets: $0) }
                    Button("Add item") { editing = DraftItem(id: UUID().uuidString, name: "", amountCents: 0, people: [ItemShares.me]) }
                }
                // a retry after an unconfirmed save must resend the same body with the same key
                .disabled(locked)
                Section("Tax, tip and fees") {
                    Field(label: "Tax", error: extraError(taxText)) { TextField("0.00", text: $taxText).keyboardType(.decimalPad) }
                    Field(label: "Tip", error: extraError(tipText)) { TextField("0.00", text: $tipText).keyboardType(.decimalPad) }
                    Field(label: "Fees", error: extraError(feesText)) { TextField("0.00", text: $feesText).keyboardType(.decimalPad) }
                    if !isTheyPaid, let result, result.gapCents != 0 {
                        LabeledContent("Difference from bank") { MoneyText(cents: result.gapCents, colored: false) }
                    }
                }
                .disabled(locked)
                Section {
                    if let result {
                        ForEach(result.shares, id: \.person) { share in
                            LabeledContent(label(share.person)) { MoneyText(cents: share.cents, colored: false) }
                        }
                    }
                    if let sharesProblem {
                        Text(sharesProblem).textStyle(.caption, color: Palette.loss)
                    }
                    InlineError(message: error)
                } header: { Text("Shares") }
                Section {
                    Button("Read receipt again") { confirmReread = true }
                        .disabled(locked)
                        .confirmationDialog("Read the receipt again?", isPresented: $confirmReread, titleVisibility: .visible) {
                            Button("Read again", role: .destructive) { Task { await read() } }
                        } message: { Text("Replaces the items and who had them.") }
                }
            }
        }
        .sheet(item: $editing) { item in
            ItemEditSheet(item: item, choices: choices) { done in
                if let i = items.firstIndex(where: { $0.id == done.id }) { items[i] = done } else { items.append(done) }
                error = nil
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

    private var locked: Bool { writes.unresolved || busy || reading }

    private func cents(_ text: String) -> Int? {
        if text.trimmingCharacters(in: .whitespaces).isEmpty { return 0 }
        guard let c = Money.parse(text), c <= DraftItem.maxCents else { return nil }
        return c
    }

    private func extraError(_ text: String) -> String? {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        guard let c = Money.parse(text) else { return "Enter an amount like 1.25" }
        return c > DraftItem.maxCents ? "Must be 100,000.00 or less" : nil
    }

    private var shareItems: [ItemShares.Item] { items.map { ItemShares.Item(amountCents: $0.amountCents, people: $0.people) } }
    private var itemsTotal: Int { items.reduce(0) { $0 + $1.amountCents } }

    private var result: ItemShares.Result? {
        guard let tax = cents(taxText), let tip = cents(tipText), let fees = cents(feesText) else { return nil }
        let target = isTheyPaid ? itemsTotal + tax + tip + fees : -transaction.amountCents
        return ItemShares.compute(items: shareItems, taxCents: tax, tipCents: tip, feesCents: fees, targetCents: target)
    }

    /// Why Save is off, when it isn't an extras field (those show their own error).
    private var sharesProblem: String? {
        guard !items.isEmpty, cents(taxText) != nil, cents(tipText) != nil, cents(feesText) != nil else { return nil }
        if let result {
            // on a "they paid" row your share must be above zero
            guard isTheyPaid, (result.shares.first { $0.person == ItemShares.me }?.cents ?? 0) == 0 else { return nil }
            return "At least one item has to be yours."
        }
        // unscaled, every share is its item total: if that works, the bank amount is too small to give everyone a cent
        if ItemShares.compute(items: shareItems, taxCents: 0, tipCents: 0, feesCents: 0, targetCents: itemsTotal) != nil {
            return "Each person's share must be more than zero."
        }
        return "Every item needs someone, and each person's items must add up to more than zero."
    }

    private var canSave: Bool { loaded && loadError == nil && !busy && !reading && result != nil && sharesProblem == nil }

    private func apply(_ it: Itemization) {
        items = it.items.map { DraftItem(id: $0.id, name: $0.name, amountCents: $0.amountCents, people: $0.people) }
        let text = { (c: Int?) in (c ?? 0) == 0 ? "" : Money.format(c ?? 0).replacingOccurrences(of: "$", with: "") }
        taxText = text(it.taxCents)
        tipText = text(it.tipCents)
        feesText = text(it.feesCents)
        handEdited = it.handEdited
    }

    private func load() async {
        guard !loaded, !loading, let client = model.client else { return }
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let it = try await client.receiptItems(transactionId: transaction.id)
            apply(it)
            loaded = true
            // items saved by hand have no readAt: reading now would replace them
            if it.readAt == nil && it.items.isEmpty { await read() }
        } catch {
            // not an empty list: saving over items that were never loaded would replace them
            loadError = errorMessage(error)
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
            if case .api(503, let body) = error as? ClientError, body.code == "READER_NOT_CONFIGURED" {
                self.error = "Receipt reading isn't set up on the server. You can add the items by hand."
            } else {
                self.error = "Couldn't read the receipt. You can add the items by hand."
            }
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
