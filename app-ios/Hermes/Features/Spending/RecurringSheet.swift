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
    @State private var confirmDelete = false

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var patch: PatchRecurringBody {
        PatchRecurringBody(name: !trimmedName.isEmpty && trimmedName != item.name ? trimmedName : nil,
                           frequency: frequency != item.frequency ? frequency : nil)
    }
    private var dirty: Bool { patch.name != nil || patch.frequency != nil }

    var body: some View {
        Sheet(title: "Recurring", canSave: dirty, busy: busy, unresolved: writes.unresolved, dirty: dirty,
              onCancel: { dismiss() }, onSave: { Task { await send(patch) } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "Name") { TextField("Name", text: $name) }
                    .disabled(busy || writes.unresolved)
                Picker("Repeats", selection: $frequency) {
                    ForEach(RecurringFrequency.writable, id: \.self) { Text(RecurringFrequency.label($0)).tag($0) }
                }
                .disabled(busy || writes.unresolved)
                LabeledContent("Last charge") {
                    Text("\(DayText.display(item.lastDate)) · \(Money.format(item.lastCents))")
                }
                NavigationLink {
                    PayeeHistoryView(match: [URLQueryItem(name: "recurringId", value: item.id)], title: item.name) { _ in await onDone() }
                } label: { Text("History") }
            }
            Section {
                InlineError(message: error)
                if item.source == "plaid" {
                    HButton(title: item.hidden ? "Show again" : "Not recurring", kind: .destructive, busy: busy) {
                        Task { await send(PatchRecurringBody(hidden: !item.hidden), guarded: false) }
                    }
                } else {
                    HButton(title: "Delete", kind: .destructive, busy: busy) { confirmDelete = true }
                        .confirmationDialog("Delete this recurring item?", isPresented: $confirmDelete, titleVisibility: .visible) {
                            Button("Delete", role: .destructive) { Task { await run(guarded: false) { try await $0.deleteRecurring(id: item.id) } } }
                        }
                }
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            name = item.name
            frequency = item.frequency == "unknown" ? "monthly" : item.frequency
        }
    }

    /// Hide/show sets the state outright, so it takes a fresh key and leaves Save's guard alone.
    private func send(_ body: PatchRecurringBody, guarded: Bool = true) async {
        let key = guarded ? writes.key : UUID().uuidString
        await run(guarded: guarded) { _ = try await $0.patchRecurring(id: item.id, body: body, idempotencyKey: key) }
    }

    private func run(guarded: Bool = true, _ write: (APIClient) async throws -> Void) async {
        guard !busy, let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            try await write(client)
            if guarded { writes.didSucceed() }
            await onDone()
            dismiss()
        } catch {
            if guarded { writes.didFail(error) }
            self.error = guarded && writes.unresolved ? "Couldn't confirm the save. Try again." : errorMessage(error)
        }
    }
}
