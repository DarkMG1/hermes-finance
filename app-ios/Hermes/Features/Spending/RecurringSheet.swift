import HermesKit
import SwiftUI

struct RecurringSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: RecurringItem
    let onDone: () async -> Void

    @State private var name = ""
    @State private var frequency = "monthly"
    @State private var writes = WriteGuard()
    @State private var busy = false
    @State private var error: String?
    @State private var loaded = false

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var patch: PatchRecurringBody {
        PatchRecurringBody(name: !trimmedName.isEmpty && trimmedName != item.name ? trimmedName : nil,
                           frequency: frequency != startFrequency ? frequency : nil)
    }
    private var startFrequency: String { item.frequency == "unknown" ? "monthly" : item.frequency }
    private var dirty: Bool { patch.name != nil || patch.frequency != nil }

    var body: some View {
        Sheet(title: "Recurring", canSave: dirty, busy: busy, unresolved: writes.unresolved, dirty: dirty,
              onCancel: { dismiss() }, onSave: { Task { await send(patch) } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "Name") { TextField("Name", text: $name) }
                Picker("Repeats", selection: $frequency) {
                    ForEach(RecurringFrequency.writable, id: \.self) { Text(RecurringFrequency.label($0)).tag($0) }
                }
                LabeledContent("Last charge") {
                    Text("\(DayText.display(item.lastDate)) · \(Money.format(item.lastCents))")
                }
            }
            Section {
                InlineError(message: error)
                if item.source == "plaid" {
                    HButton(title: item.hidden ? "Show again" : "Not recurring", kind: .destructive, busy: busy) {
                        Task { await send(PatchRecurringBody(hidden: !item.hidden)) }
                    }
                } else {
                    HButton(title: "Delete", kind: .destructive, busy: busy) { Task { await run { try await $0.deleteRecurring(id: item.id) } } }
                }
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            name = item.name
            frequency = startFrequency
        }
    }

    private func send(_ body: PatchRecurringBody) async {
        await run { _ = try await $0.patchRecurring(id: item.id, body: body, idempotencyKey: writes.key) }
    }

    private func run(_ write: (APIClient) async throws -> Void) async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            try await write(client)
            writes.didSucceed()
            await onDone()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Try again." : errorMessage(error)
        }
    }
}
