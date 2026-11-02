import HermesKit
import SwiftUI

/// A deposit (or one positive split line) a person paid back with.
struct PaybackTarget: Identifiable, Hashable {
    let transactionId: String
    let lineId: String?
    let personId: String
    let paybackCents: Int
    var id: String { "\(transactionId)|\(lineId ?? "")|\(personId)" }
}

/// The open-items read before a payback is tagged failed: nothing was written.
struct PaybackChoicesUnavailable: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

extension AppModel {
    /// nil from a server before 2.1.0, which has no payback route.
    func paybackChoices(_ target: PaybackTarget) async throws -> PaybackChoices? {
        guard let reader else { return nil }
        do {
            let query = [URLQueryItem(name: "personId", value: target.personId)] + (target.lineId.map { [URLQueryItem(name: "lineId", value: $0)] } ?? [])
            return try await reader.read("/v1/transactions/\(target.transactionId)/payback", query: query, as: PaybackChoices.self).value
        } catch ClientError.api(status: 404, _) {
            return nil
        }
    }

    /// Tags a payback to a person. True when there are open items to choose from: show `PaybackPicker` instead, it tags on save.
    /// Throws `PaybackChoicesUnavailable` when the read fails, so callers don't treat it as a write.
    func tagPayback(_ target: PaybackTarget, idempotencyKey: String) async throws -> Bool {
        guard let client else { return false }
        let choices: PaybackChoices?
        do { choices = try await paybackChoices(target) } catch { throw PaybackChoicesUnavailable(message: errorMessage(error)) }
        if let choices, !choices.items.isEmpty || !choices.linked.isEmpty { return true }
        if let lineId = target.lineId {
            _ = try await client.patchSplitLine(transactionId: target.transactionId, lineId: lineId,
                                                body: PatchSplitLineBody(personId: .set(target.personId)), idempotencyKey: idempotencyKey)
        } else {
            _ = try await client.patchTransaction(id: target.transactionId, body: PatchTransactionBody(personId: .set(target.personId)),
                                                  idempotencyKey: idempotencyKey)
        }
        return false
    }
}

/// Which open items a payback paid; saving also tags the payback to the person.
struct PaybackPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: PaybackTarget
    let onDone: () async -> Void
    @State private var choices: PaybackChoices?
    @State private var selected: Set<String> = []
    /// One key until the outcome is known, and the selection frozen meanwhile: a retry resends exactly what may have been saved.
    @State private var writes = WriteGuard()
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Sheet(title: "What is this paying back?", canSave: choices != nil, busy: busy, unresolved: writes.unresolved,
              onCancel: { dismiss() }, onSave: { Task { await save() } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            InlineError(message: error)
            if let choices {
                let fills = Dictionary(PaybackFill.amounts(choices.items, selected: selected, paybackCents: target.paybackCents)
                    .map { ("\($0.transactionId)|\($0.lineId ?? "")", $0.amountCents) }, uniquingKeysWith: { a, _ in a })
                Button { selected = [] } label: { SelectionRow(title: "Just the balance", selected: selected.isEmpty) }
                    .disabled(writes.unresolved)
                Section {
                    ForEach(PaybackFill.ordered(choices.items, paybackCents: target.paybackCents)) { item in
                        Button {
                            selected = PaybackFill.reachable(choices.items, selected: selected.symmetricDifference([item.id]),
                                                             paybackCents: target.paybackCents)
                        } label: {
                            ListRow(title: item.payee, subtitle: "\(DayText.display(item.date)) · \(Money.format(item.leftCents)) left") {
                                if selected.contains(item.id) {
                                    Text(Money.format(fills[item.id] ?? 0)).textStyle(.body).monospacedDigit()
                                    Image(systemName: "checkmark").foregroundStyle(Palette.accent)
                                }
                            }
                            .foregroundStyle(Palette.text)
                        }
                        .accessibilityAddTraits(selected.contains(item.id) ? .isSelected : [])
                    }
                }
                .disabled(writes.unresolved)
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            } else {
                Button("Retry") { Task { await load() } }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            guard let loaded = try await model.paybackChoices(target) else { error = "This server can't link paybacks."; return }
            choices = loaded
            // a linked charge that was untagged or deleted since is no longer an item to tick
            let linked = Set(loaded.linked.map { "\($0.transactionId)|\($0.lineId ?? "")" }).intersection(loaded.items.map(\.id))
            let ticked = linked.isEmpty ? PaybackFill.preselected(loaded.items, paybackCents: target.paybackCents) : linked
            selected = PaybackFill.reachable(loaded.items, selected: ticked, paybackCents: target.paybackCents)
            error = nil
        } catch {
            self.error = errorMessage(error)
        }
    }

    private func save() async {
        guard !busy, let client = model.client, let choices else { return }
        busy = true
        defer { busy = false }
        do {
            let items = PaybackFill.amounts(choices.items, selected: selected, paybackCents: target.paybackCents)
            _ = try await client.putPayback(transactionId: target.transactionId,
                                            body: PaybackBody(personId: target.personId, lineId: target.lineId, items: items),
                                            idempotencyKey: writes.key)
            writes.didSucceed()
            await onDone()
            dismiss()
        } catch {
            writes.didFail(error)
            // refused (an item closed or retagged elsewhere): show what the server has now
            if !writes.unresolved { await load() }
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry." : errorMessage(error)
        }
    }
}
