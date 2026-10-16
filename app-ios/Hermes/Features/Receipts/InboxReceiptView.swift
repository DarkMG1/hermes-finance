import HermesKit
import SwiftUI

/// One waiting receipt: check the photo, link it, log it as paid by someone, or tag its items now.
struct InboxReceiptView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var receipt: InboxReceipt
    let onChange: () async -> Void

    @State private var photo: UIImage?
    @State private var error: String?
    @State private var busy = false
    @State private var confirming: LedgerTransaction?
    @State private var picking = false
    @State private var choosingPayer = false
    @State private var payer: Person?
    @State private var itemizing: ItemizeSource?
    @State private var confirmDelete = false
    @State private var confirmReread = false
    @State private var viewing = false
    @State private var picked: LedgerTransaction?
    /// Picked from the Link sheet; confirmed at its button.
    @State private var pickedToConfirm: LedgerTransaction?
    @State private var linked: LedgerTransaction?
    @State private var linkWrites = WriteGuard()
    @State private var linkTarget: String?
    @State private var payWrites = WriteGuard()
    @State private var payTarget: String?
    /// Paid by added the transaction but the link failed: retry just the link.
    @State private var unlinked: LedgerTransaction?

    var body: some View {
        List {
            Section {
                if let photo {
                    Button { viewing = true } label: {
                        Image(uiImage: photo).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: Space.xxl * 9)
                            .clipShape(RoundedRectangle(cornerRadius: Space.s))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Receipt photo")
                    .accessibilityHint("Opens it full screen")
                    .fullScreenCover(isPresented: $viewing) { ReceiptViewer(image: photo) }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
                LabeledContent("Store", value: receipt.merchant ?? "Not read")
                if let total = receipt.totalCents { LabeledContent("Total") { MoneyText(cents: total, colored: false) } }
                if let day = receipt.purchaseDate { LabeledContent("Date", value: DayText.display(day)) }
            }
            if !receipt.suggestions.isEmpty {
                Section("Suggested charges") {
                    ForEach(receipt.suggestions) { t in
                        Button { confirming = t } label: { TransactionRow(transaction: t).contentShape(Rectangle()) }.buttonStyle(.plain)
                            .confirmationDialog(confirmTitle(t), isPresented: Binding(get: { confirming?.id == t.id }, set: { if !$0 { confirming = nil } }),
                                                titleVisibility: .visible) {
                                Button("Link") { Task { await link(t) } }
                            }
                    }
                }
                .disabled(busy)
            }
            Section {
                Button("Link to transaction…") { picking = true }
                    .confirmationDialog(pickedToConfirm.map(confirmTitle) ?? "",
                                        isPresented: Binding(get: { pickedToConfirm != nil }, set: { if !$0 { pickedToConfirm = nil } }),
                                        titleVisibility: .visible) {
                        Button("Link") { if let t = pickedToConfirm { Task { await link(t) } } }
                    }
                if let unlinked {
                    Button("Retry link to \(unlinked.payee)") { Task { await link(unlinked, thenItemize: true) } }
                } else {
                    Button("Paid by…") { choosingPayer = true }
                        .confirmationDialog("Who paid?", isPresented: $choosingPayer) {
                            ForEach(model.people.filter { !$0.archived }) { person in
                                Button(person.name) { if receipt.totalCents != nil { Task { await paidBy(person) } } else { payer = person } }
                            }
                        }
                }
                Button("Itemize") { itemizing = .inbox(receipt.id) }
                // dialogs on their buttons: on the List they float mid-screen over the photo
                Button("Read again") { if receipt.tagged { confirmReread = true } else { Task { await readAgain() } } }
                    .confirmationDialog("Read the receipt again?", isPresented: $confirmReread, titleVisibility: .visible) {
                        Button("Read again", role: .destructive) { Task { await readAgain() } }
                    } message: { Text("Replaces the items and who had them.") }
                Button("Delete", role: .destructive) { confirmDelete = true }
                    .confirmationDialog("Delete this receipt?", isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Delete", role: .destructive) { Task { await delete() } }
                    }
            }
            .disabled(busy)
            InlineError(message: error)
        }
        .themedForm()
        .navigationTitle(receipt.merchant ?? "Receipt")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadPhoto() }
        .sheet(isPresented: $picking, onDismiss: { pickedToConfirm = picked; picked = nil }, content: {
            ExpensePicker(title: "Link to transaction", suggestions: receipt.suggestions,
                          allows: { $0.amountCents < 0 && $0.hasReceipt != true }, onPick: { t in picked = t })
        })
        // set after the sheet closes: SwiftUI drops a sheet presented while another is up
        .sheet(item: $payer, onDismiss: { if let t = linked { itemizing = .transaction(t) } }, content: { person in
            TheyPaidSheet(person: person, prefill: .init(payee: receipt.payee ?? "", date: day, totalCents: receipt.totalCents),
                          onCreated: { created in await link(created, thenItemize: true) }, onDone: {})
        })
        // linked: this inbox receipt is gone, so close its stale screen too
        .sheet(item: $itemizing, onDismiss: { if linked != nil { dismiss() } else { Task { await refresh() } } }, content: { source in
            ItemizeView(source: source) { await onChange() }
        })
    }

    private func confirmTitle(_ t: LedgerTransaction) -> String {
        return "Link to \(t.payee) \(Money.format(-t.amountCents)) on \(DayText.display(t.date))?"
    }

    private var day: Date {
        DayText.date(receipt.purchaseDate ?? String(receipt.capturedAt.prefix(10))) ?? .now
    }

    private func loadPhoto() async {
        guard photo == nil, let client = model.client else { return }
        do { photo = UIImage(data: try await client.inboxPhoto(id: receipt.id)) } catch { self.error = errorMessage(error) }
    }

    /// Re-reads this receipt; once it is linked (a save or a read can link it), the screen closes.
    private func refresh() async {
        await onChange()
        guard let list = try? await model.client?.inbox() else { return }
        if let fresh = list.waiting.first(where: { $0.id == receipt.id }) { receipt = fresh } else { dismiss() }
    }

    private func link(_ t: LedgerTransaction, thenItemize: Bool = false) async {
        guard let client = model.client else { return }
        if linkTarget != t.id { linkWrites = WriteGuard(); linkTarget = t.id }
        busy = true
        defer { busy = false }
        do {
            let result = try await client.linkInboxReceipt(id: receipt.id, transactionId: t.id, idempotencyKey: linkWrites.key)
            linkWrites.didSucceed()
            unlinked = nil
            await onChange()
            // tags that couldn't be applied: show the itemizing so the owner sees the shares weren't set
            guard thenItemize || (receipt.tagged && !result.splitApplied) else { dismiss(); return }
            let fresh = try? await model.reader?.read("/v1/transactions/\(t.id)", as: LedgerTransaction.self).value
            linked = fresh ?? t
            // under Paid by's sheet, its onDismiss opens Itemize
            if payer == nil { itemizing = .transaction(fresh ?? t) }
        } catch {
            linkWrites.didFail(error)
            unlinked = linkWrites.unresolved && thenItemize ? t : nil
            if case .api(404, _) = error as? ClientError { await refresh() }
            self.error = linkWrites.unresolved ? "Couldn't confirm the link. Try again; it won't link twice." : errorMessage(error)
        }
    }

    /// Logs the receipt total as paid by `person`, links the receipt, and opens Itemize, whose save sets your share.
    private func paidBy(_ person: Person) async {
        guard let client = model.client, let total = receipt.totalCents else { return }
        if payTarget != person.id { payWrites = WriteGuard(); payTarget = person.id }
        busy = true
        do {
            let created = try await client.createTransaction(
                CreateTransactionBody(date: DayText.ymd(day), amountCents: -total, payee: receipt.payee ?? "Receipt", categoryId: nil, notes: nil,
                                      paidByPersonId: person.id), idempotencyKey: payWrites.key)
            payWrites.didSucceed()
            busy = false
            await link(created, thenItemize: true)
        } catch {
            payWrites.didFail(error)
            busy = false
            self.error = payWrites.unresolved ? "Couldn't confirm the save. Try again; it won't be added twice." : errorMessage(error)
        }
    }

    private func readAgain() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.readInboxReceipt(id: receipt.id)
            await refresh()
        } catch ClientError.api(409, let body) where body.code == "LINKED" {
            await refresh()
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func delete() async {
        do {
            try await model.client?.deleteInboxReceipt(id: receipt.id)
            await onChange()
            dismiss()
        } catch {
            self.error = errorMessage(error)
        }
    }
}
