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
    @State private var choosingFor = false
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
    @State private var payment = PendingWrite<CreateTransactionBody>()
    @State private var forWrite = PendingWrite<InboxForBody>()
    @State private var pendingLink = PendingReceiptLink()

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
                if let personId = receipt.forPersonId {
                    Text("For \(model.personName(personId)): they owe the whole charge").textStyle(.subhead, color: Palette.secondaryText)
                }
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
                .disabled(busy || payment.guardState.unresolved || pendingLink.target != nil || forWrite.guardState.unresolved)
            }
            Section {
                Button("Link to transaction…") { picking = true }
                    .confirmationDialog(pickedToConfirm.map(confirmTitle) ?? "",
                                        isPresented: Binding(get: { pickedToConfirm != nil }, set: { if !$0 { pickedToConfirm = nil } }),
                                        titleVisibility: .visible) {
                        Button("Link") { if let t = pickedToConfirm { Task { await link(t) } } }
                    }
                    .disabled(payment.guardState.unresolved || pendingLink.target != nil || forWrite.guardState.unresolved)
                if let retry = pendingLink.target {
                    Button("Retry link to \(retry.payee)") { Task { await link(retry, thenItemize: pendingLink.createdPayment?.id == retry.id) } }
                } else if payment.guardState.unresolved, let personId = payment.body?.paidByPersonId {
                    Button("Retry paid by \(model.personName(personId))") { Task { await paidBy(personId) } }
                } else {
                    Button("Paid by…") { choosingPayer = true }
                        .confirmationDialog("Who paid?", isPresented: $choosingPayer) {
                            ForEach(model.people.filter { !$0.archived }) { person in
                                Button(person.name) { if receipt.totalCents != nil { Task { await paidBy(person.id) } } else { payer = person } }
                            }
                        }
                        .disabled(receipt.forPersonId != nil || forWrite.guardState.unresolved)
                }
                if forWrite.guardState.unresolved {
                    Button("Retry For…") { Task { await setFor(forWrite.body?.personId) } }
                } else {
                    Button("For…") { choosingFor = true }
                        .confirmationDialog("Who is the charge for?", isPresented: $choosingFor) {
                            Button("Nobody") { Task { await setFor(nil) } }
                            ForEach(model.people.filter { !$0.archived }) { person in
                                Button(person.name) { Task { await setFor(person.id) } }
                            }
                        }
                        .disabled(payment.guardState.unresolved || pendingLink.target != nil)
                }
                Button("Itemize") { itemizing = .inbox(receipt.id) }
                    .disabled(payment.guardState.unresolved || pendingLink.target != nil || forWrite.guardState.unresolved || receipt.forPersonId != nil)
                // dialogs on their buttons: on the List they float mid-screen over the photo
                Button("Read again") { if receipt.tagged { confirmReread = true } else { Task { await readAgain() } } }
                    .confirmationDialog("Read the receipt again?", isPresented: $confirmReread, titleVisibility: .visible) {
                        Button("Read again", role: .destructive) { Task { await readAgain() } }
                    } message: { Text("Replaces the items and who had them.") }
                    .disabled(payment.guardState.unresolved || pendingLink.target != nil || forWrite.guardState.unresolved)
                Button("Delete", role: .destructive) { confirmDelete = true }
                    .confirmationDialog("Delete this receipt?", isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Delete", role: .destructive) { Task { await delete() } }
                    }
                    .disabled(payment.guardState.unresolved || pendingLink.target != nil || forWrite.guardState.unresolved)
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
                          allows: { $0.amountCents < 0 && $0.hasReceipt != true
                              && (receipt.forPersonId == nil || ($0.paidByPersonId == nil && $0.splitLines.isEmpty)) }, onPick: { t in picked = t })
        })
        // set after the sheet closes: SwiftUI drops a sheet presented while another is up
        .sheet(item: $payer, onDismiss: { if let t = linked { itemizing = .transaction(t) } }, content: { person in
            TheyPaidSheet(person: person, prefill: .init(payee: receipt.payee ?? receipt.merchant ?? "", date: day, totalCents: receipt.totalCents),
                          inboxReceiptId: receipt.id,
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

    /// Keep a created payment's link retry reachable even if the receipt disappeared.
    private func refresh() async {
        await onChange()
        guard let list = try? await model.client?.inbox() else { return }
        if let fresh = list.waiting.first(where: { $0.id == receipt.id }) { receipt = fresh } else if pendingLink.target == nil { dismiss() }
    }

    private func link(_ t: LedgerTransaction, thenItemize: Bool = false) async {
        guard !busy, !payment.guardState.unresolved, !forWrite.guardState.unresolved, pendingLink.allows(t.id),
              let client = model.client else { return }
        if thenItemize { pendingLink.createdPayment = t }
        pendingLink.unlinked = t
        if linkTarget != t.id { linkWrites = WriteGuard(); linkTarget = t.id }
        busy = true
        defer { busy = false }
        do {
            var needsItemizing = thenItemize
            // Atomic Paid-by creation already attached the receipt.
            if !thenItemize || t.hasReceipt != true {
                let result = try await client.linkInboxReceipt(id: receipt.id, transactionId: t.id, idempotencyKey: linkWrites.key)
                needsItemizing = needsItemizing || (receipt.forPersonId == nil && receipt.tagged && !result.splitApplied)
            }
            linkWrites.didSucceed()
            pendingLink = PendingReceiptLink()
            await onChange()
            // tags that couldn't be applied: show the itemizing so the owner sees the shares weren't set
            guard needsItemizing else { dismiss(); return }
            let fresh = try? await model.reader?.read("/v1/transactions/\(t.id)", as: LedgerTransaction.self).value
            linked = fresh ?? t
            // under Paid by's sheet, its onDismiss opens Itemize
            if payer == nil { itemizing = .transaction(fresh ?? t) }
        } catch {
            linkWrites.didFail(error)
            if !linkWrites.unresolved { pendingLink.unlinked = nil }
            if case .api(404, _) = error as? ClientError { await refresh() }
            self.error = linkWrites.unresolved ? "Couldn't confirm the link. Try again; it won't link twice." : errorMessage(error)
        }
    }

    /// Logs and links the receipt total, retaining the submitted body until confirmed.
    private func paidBy(_ personId: String) async {
        guard !busy, pendingLink.target == nil, !forWrite.guardState.unresolved, receipt.forPersonId == nil, let client = model.client else { return }
        guard let total = receipt.totalCents ?? payment.body.map({ -$0.amountCents }) else { return }
        let body = payment.prepare(CreateTransactionBody(date: DayText.ymd(day), amountCents: -total,
                                                         payee: receipt.payee ?? receipt.merchant ?? "Receipt",
                                                         categoryId: nil, notes: nil, paidByPersonId: personId, inboxReceiptId: receipt.id))
        busy = true
        do {
            let created = try await client.createTransaction(body, idempotencyKey: payment.guardState.key)
            payment.guardState.didSucceed()
            pendingLink.unlinked = created
            busy = false
            await link(created, thenItemize: true)
        } catch {
            payment.guardState.didFail(error)
            busy = false
            if case .api(404, _) = error as? ClientError { await refresh() }
            self.error = payment.guardState.unresolved ? "Couldn't confirm the save. Try again; it won't be added twice." : errorMessage(error)
        }
    }

    private func setFor(_ personId: String?) async {
        guard !busy, !payment.guardState.unresolved, pendingLink.target == nil, let client = model.client else { return }
        let body = forWrite.prepare(InboxForBody(personId: personId))
        busy = true
        defer { busy = false }
        do {
            receipt = try await client.setInboxFor(id: receipt.id, body: body, idempotencyKey: forWrite.guardState.key)
            forWrite.guardState.didSucceed()
            await refresh()
        } catch {
            forWrite.guardState.didFail(error)
            if case .api(404, _) = error as? ClientError { await refresh() }
            self.error = forWrite.guardState.unresolved ? "Couldn't confirm the save. Retry For to confirm it." : errorMessage(error)
        }
    }

    private func readAgain() async {
        guard !busy, !payment.guardState.unresolved, !forWrite.guardState.unresolved, pendingLink.target == nil, let client = model.client else { return }
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
        guard !busy, !payment.guardState.unresolved, !forWrite.guardState.unresolved, pendingLink.target == nil else { return }
        do {
            try await model.client?.deleteInboxReceipt(id: receipt.id)
            await onChange()
            dismiss()
        } catch {
            self.error = errorMessage(error)
        }
    }
}
