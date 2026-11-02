import HermesKit
import SwiftUI

/// Rows still in the Reimbursement category, one per split line in it, to move onto a person's IOUs.
struct ReimbursementsCleanupView: View {
    @Environment(AppModel.self) private var model
    @State private var entries: [Entry]?
    /// Moved or skipped; a skip is this screen's only, so it comes back on the next visit.
    @State private var hidden: Set<String> = []
    @State private var writes: [String: WriteGuard] = [:]
    @State private var busyIds: Set<String> = []
    @State private var paying: PaybackTarget?
    @State private var error: String?

    struct Entry: Identifiable {
        let transaction: LedgerTransaction
        let lineId: String?
        let amountCents: Int
        var id: String { "\(transaction.id)|\(lineId ?? "")" }
    }

    var body: some View {
        List {
            InlineError(message: error)
            if let entries {
                let shown = entries.filter { !hidden.contains($0.id) }
                if shown.isEmpty { Text("Nothing left to move").textStyle(.subhead, color: Palette.secondaryText) }
                ForEach(shown) { entry in
                    NavigationLink {
                        PersonPicker(selection: Binding(get: { nil }, set: { id in
                            if let id { Task { await move(entry, to: id) } }
                        }), noneTitle: "Leave it", title: entry.amountCents < 0 ? "For" : "Repaid by")
                    } label: {
                        ListRow(title: entry.transaction.payee, subtitle: DayText.display(entry.transaction.date)) {
                            MoneyText(cents: entry.amountCents)
                        }
                    }
                    .disabled(busyIds.contains(entry.id))
                    .swipeActions { Button("Skip") { hidden.insert(entry.id) } }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .themedForm()
        .navigationTitle("Move to IOUs")
        .navigationBarTitleDisplayMode(.inline)
        // once: the person picker's pop would reload under a write in flight
        .task { if entries == nil { await load() } }
        .refreshable { await load() }
        .sheet(item: $paying) { target in
            PaybackPicker(transactionId: target.transactionId, lineId: target.lineId, personId: target.personId,
                          paybackCents: target.paybackCents) { hidden.insert("\(target.transactionId)|\(target.lineId ?? "")") }
        }
    }

    /// A charge (or negative line) is tagged straight away; a payback goes through the picker when it has items to choose from.
    private func move(_ entry: Entry, to personId: String) async {
        guard let client = model.client, !busyIds.contains(entry.id) else { return }
        busyIds.insert(entry.id)
        defer { busyIds.remove(entry.id) }
        let slot = "\(entry.id)|\(personId)"
        var writeGuard = writes[slot] ?? WriteGuard()
        do {
            if entry.amountCents > 0 {
                let target = PaybackTarget(transactionId: entry.transaction.id, lineId: entry.lineId, personId: personId,
                                           paybackCents: entry.amountCents)
                if try await model.tagPayback(target, idempotencyKey: writeGuard.key) { paying = target } else { hidden.insert(entry.id) }
            } else if let lineId = entry.lineId {
                _ = try await client.patchSplitLine(transactionId: entry.transaction.id, lineId: lineId,
                                                    body: PatchSplitLineBody(personId: .set(personId)), idempotencyKey: writeGuard.key)
                hidden.insert(entry.id)
            } else {
                _ = try await client.patchTransaction(id: entry.transaction.id, body: PatchTransactionBody(personId: .set(personId)),
                                                      idempotencyKey: writeGuard.key)
                hidden.insert(entry.id)
            }
            writeGuard.didSucceed()
            error = nil
        } catch {
            writeGuard.didFail(error)
            self.error = writeGuard.unresolved ? "Couldn't confirm. Try again." : errorMessage(error)
        }
        writes[slot] = writeGuard
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            let rows = try await reader.read("/v1/people/reimbursements-cleanup", as: ReimbursementsCleanup.self).value.rows
            // the server's rule: a transfer category named Reimburs…
            let reimbursement = Set(model.categories.filter { $0.isTransfer && $0.name.lowercased().hasPrefix("reimburs") }.map(\.id))
            entries = rows.flatMap { row in
                row.splitLines.isEmpty ? [Entry(transaction: row, lineId: nil, amountCents: row.amountCents)]
                    : row.splitLines.filter { $0.categoryId.map(reimbursement.contains) ?? false }
                        .map { Entry(transaction: row, lineId: $0.id, amountCents: $0.amountCents) }
            }
            error = nil
        } catch {
            self.error = errorMessage(error)
        }
    }
}
