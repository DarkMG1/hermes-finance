import HermesKit
import SwiftUI

/// Lots by account, with each account's matching method. Unverified lots (shares held before the history) stand out until their date
/// and cost are entered.
struct TaxLotsView: View {
    @Environment(AppModel.self) private var model
    @State private var lots: TaxLots?
    @State private var error: String?

    var body: some View {
        List {
            InlineError(message: error)
            if let lots {
                let accounts = Array(Set(lots.lots.map(\.accountId)).union(lots.methods.keys).union(lots.unresolved.map(\.accountId)))
                    .sorted { model.accountName($0) < model.accountName($1) }
                if accounts.isEmpty { Text("No investment lots").textStyle(.subhead, color: Palette.secondaryText) }
                ForEach(accounts, id: \.self) { account in
                    Section(model.accountName(account)) {
                        LotMethodRow(accountId: account, method: lots.methods[account], inferred: lots.inferred[account] ?? true,
                                     matched: lots.basisMatched[account] ?? true) { await load() }
                        ForEach(lots.lots.filter { $0.accountId == account }) { LotRow(lot: $0) { await load() } }
                        ForEach(lots.unresolved.filter { $0.accountId == account }, id: \.securityId) { UnresolvedRow(shares: $0) { await load() } }
                    }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .themedForm()
        .navigationTitle("Lots")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            lots = try await client.taxLots()
            error = nil
        } catch {
            self.error = errorMessage(error)
        }
    }
}

/// The account's method, inferred or set by the owner; picking Inferred goes back to the inferred one.
private struct LotMethodRow: View {
    @Environment(AppModel.self) private var model
    let accountId: String
    let method: String?
    let inferred: Bool
    /// false: no method matched the cost basis, so FIFO is the default
    let matched: Bool
    let onChange: () async -> Void
    @State private var writes = WriteGuard()
    /// the method of a write whose outcome is unknown: a retry of it reuses its key
    @State private var pending: String??
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Picker("Lot method", selection: Binding { inferred ? "" : method ?? "" } set: { m in Task { await set(m.isEmpty ? nil : m) } }) {
                Text("Inferred").tag("")
                ForEach(Self.methods, id: \.value) { Text($0.label).tag($0.value) }
            }
            if let method {
                let label = Self.methods.first { $0.value == method }?.label ?? method
                let how = !inferred ? "set by you" : matched ? "inferred from the cost basis" : "the default: the cost basis matches no method"
                Text("\(label), \(how)").textStyle(.caption, color: Palette.secondaryText)
            }
            InlineError(message: error)
        }
    }

    static let methods: [(value: String, label: String)] = [("fifo", "FIFO"), ("hifo", "HIFO"), ("specific", "Specific lots")]

    private func set(_ method: String?) async {
        guard let client = model.client else { return }
        error = nil
        // setting a method is idempotent by value, so a different pick needn't wait on the unknown one
        if writes.unresolved, pending != .some(method) { writes.didSucceed() }
        pending = method
        do {
            try await client.setLotMethod(accountId: accountId, method: method, idempotencyKey: writes.key)
            writes.didSucceed()
            await onChange()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the change. Pick it again to retry; it won't be applied twice." : errorMessage(error)
            // the picker then shows what the server has
            if writes.unresolved { await onChange() }
        }
    }
}

/// A lot; an unverified one offers "Enter date and cost", and one the owner entered swipes to delete.
private struct LotRow: View {
    let lot: TaxLot
    let onChange: () async -> Void
    @State private var entering = false

    var body: some View {
        let unverified = lot.status == "unverified"
        let row = VStack(alignment: .leading, spacing: Space.xs) {
            ListRow(title: "\(lot.ticker ?? "Security") · \(lot.quantity.formatted()) shares",
                    subtitle: lot.acquiredOn.map { "Bought \(DayText.display($0))" } ?? "Date unknown") {
                MoneyText(cents: lot.costCents, colored: false)
            }
            if unverified, lot.id.hasPrefix("unverified:") { Button("Enter date and cost") { entering = true } }
            if unverified { Text("Unverified: sales that touch it are blocked").textStyle(.caption, color: Palette.loss) }
        }
        .listRowBackground(unverified ? Palette.loss.opacity(0.15) : nil)
        .sheet(isPresented: $entering) {
            EnterLotForm(accountId: lot.accountId, securityId: lot.securityId, quantity: lot.quantity, onChange: onChange)
        }
        // entered lots carry their own id; the seeded unverified lot and lots from the history can't be deleted
        if lot.status != "known", !lot.id.hasPrefix("unverified:") {
            row.deleteSwipe("Delete this lot?") { client, key in
                try await client.deleteTaxLot(id: lot.id, idempotencyKey: key)
                await onChange()
            }
        } else {
            row
        }
    }
}

/// Shares past sales took from before the history: entering their date and cost settles those sales' cost.
private struct UnresolvedRow: View {
    let shares: TaxUnresolvedShares
    let onChange: () async -> Void
    @State private var entering = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            ListRow(title: "\(shares.ticker ?? "Security") · \(shares.quantity.formatted()) shares sold", subtitle: "Date and cost unknown")
            Button("Enter date and cost") { entering = true }
            Text("Held before the history: those sales' cost is unknown").textStyle(.caption, color: Palette.loss)
        }
        .listRowBackground(Palette.loss.opacity(0.15))
        .sheet(isPresented: $entering) {
            EnterLotForm(accountId: shares.accountId, securityId: shares.securityId, quantity: shares.quantity, onChange: onChange)
        }
    }
}

/// A lot for shares held before the history.
private struct EnterLotForm: View {
    @Environment(AppModel.self) private var model
    let accountId: String
    let securityId: String
    let quantity: Double
    let onChange: () async -> Void

    var body: some View {
        EditForm(title: "Enter date and cost", fields: Self.fields, original: LotDraft(quantity: quantity)) { draft, key in
            guard let date = draft.acquiredOn, let quantity = draft.quantity, let cost = draft.costCents else { return }
            try await model.client?.addTaxLot(TaxLotBody(accountId: accountId, securityId: securityId, acquiredOn: date,
                                                         quantity: quantity, costCents: cost), idempotencyKey: key)
            await onChange()
        }
    }

    struct LotDraft: Equatable {
        var acquiredOn: String?
        var quantity: Double?
        var costCents: Int?
    }

    private static let fields: [DraftField<LotDraft>] = [
        .init(key: "acquiredOn", label: "Date bought", kind: .date(\.acquiredOn), required: true),
        .init(key: "quantity", label: "Shares", kind: .number(\.quantity), required: true),
        .init(key: "costCents", label: "Total cost", kind: .money(\.costCents), required: true),
    ]
}
