import HermesKit
import SwiftUI

/// Rename an account. An empty name goes back to the bank's name; syncs never overwrite yours.
struct AccountSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let account: Account
    let onChange: () async -> Void

    @State private var name = ""
    @State private var writes = WriteGuard()
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Sheet(
            title: "Account", canSave: trimmed != account.name, busy: busy, unresolved: writes.unresolved,
            onCancel: { if writes.unresolved { Task { await onChange() } }; dismiss() }, onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "Name", error: error) { TextField("Bank's name", text: $name) }
            } footer: {
                Text("Leave empty to use the bank's name.")
            }
            .disabled(writes.unresolved)
        }
        .onAppear { name = account.name }
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func save() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.patchAccount(id: account.id, body: PatchAccountBody(name: trimmed.isEmpty ? nil : trimmed), idempotencyKey: writes.key)
            writes.didSucceed()
            await onChange()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry." : errorMessage(error)
        }
    }
}
