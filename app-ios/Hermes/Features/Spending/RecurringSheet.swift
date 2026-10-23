import HermesKit
import SwiftUI

struct RecurringSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: RecurringItem
    let onDone: () async -> Void

    @State private var name = ""
    @State private var frequency = "monthly"
    @State private var writes = PendingWrite<PatchRecurringBody>()
    @State private var cancellation = PendingWrite<Bool>()
    @State private var busy = false
    @State private var error: String?
    @State private var loaded = false
    @State private var confirmDelete = false

    private var patch: PatchRecurringBody {
        PatchRecurringBody(item: item, name: name, frequency: frequency)
    }
    private var dirty: Bool { writes.guardState.unresolved || patch.name != nil || patch.frequency != nil }

    var body: some View {
        Sheet(title: "Recurring", canSave: dirty && !cancellation.guardState.unresolved, busy: busy,
              unresolved: writes.guardState.unresolved || cancellation.guardState.unresolved, dirty: dirty,
              onCancel: { if writes.guardState.unresolved || cancellation.guardState.unresolved { Task { await onDone() } }; dismiss() },
              onSave: {
                  let body = writes.prepare(patch)
                  Task { await send(body, guard: $writes.guardState) }
              }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "Name") { TextField("Name", text: $name) }
                    .disabled(writes.guardState.unresolved || cancellation.guardState.unresolved)
                Picker("Repeats", selection: $frequency) {
                    if item.frequency == "unknown" { Text(RecurringFrequency.label("unknown")).tag("unknown") }
                    ForEach(RecurringFrequency.writable, id: \.self) { Text(RecurringFrequency.label($0)).tag($0) }
                }
                .disabled(writes.guardState.unresolved || cancellation.guardState.unresolved)
                LabeledContent("Last charge") {
                    Text("\(DayText.display(item.lastDate)) · \(Money.format(item.lastCents))")
                }
                NavigationLink {
                    PayeeHistoryView(match: [URLQueryItem(name: "recurringId", value: item.id)], title: item.name) { _ in await onDone() }
                } label: { Text("History") }
            }
            Section {
                InlineError(message: error)
                // older servers don't send `ended` and reject it in a PATCH
                if item.ended != nil {
                    HButton(title: cancellation.guardState.unresolved ? "Retry \(cancellation.body == true ? "cancellation" : "undoing cancellation")"
                            : item.cancelled == true ? "Not cancelled" : "Mark as cancelled", kind: .secondary, busy: busy) {
                        let ended = cancellation.prepare(item.cancelled != true)
                        Task { await send(PatchRecurringBody(ended: ended), guard: $cancellation.guardState) }
                    }
                    .disabled(writes.guardState.unresolved)
                    // the separator under this button runs edge to edge, not from the label's inset
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                }
                if item.source == "plaid" {
                    HButton(title: item.hidden ? "Show again" : "Not recurring", kind: .destructive, busy: busy) {
                        Task { await send(PatchRecurringBody(hidden: !item.hidden)) }
                    }
                    .disabled(writes.guardState.unresolved || cancellation.guardState.unresolved)
                } else {
                    HButton(title: "Delete", kind: .destructive, busy: busy) { confirmDelete = true }
                        .confirmationDialog("Delete this recurring item?", isPresented: $confirmDelete, titleVisibility: .visible) {
                            Button("Delete", role: .destructive) { Task { await run(nil) { try await $0.deleteRecurring(id: item.id) } } }
                        }
                        .disabled(writes.guardState.unresolved || cancellation.guardState.unresolved)
                }
            } footer: {
                if item.cancelled == true {
                    Text("Cancelled. A new charge brings it back.")
                } else if item.stopped == true {
                    Text("Ended: your bank stopped tracking this bill.")
                } else if item.ended == true {
                    Text("Ended: no charge for two periods. A new charge brings it back.")
                }
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            name = item.name
            frequency = item.frequency
        }
    }

    /// Hide/show sets the state outright, so it takes a fresh key. Cancel stamps a date on the server, so an uncertain retry
    /// replays the first attempt: a fresh key would re-cancel a bill that a newer charge has since brought back.
    private func send(_ body: PatchRecurringBody, guard writeGuard: Binding<WriteGuard>? = nil) async {
        let key = writeGuard?.wrappedValue.key ?? UUID().uuidString
        await run(writeGuard) { _ = try await $0.patchRecurring(id: item.id, body: body, idempotencyKey: key) }
    }

    private func run(_ writeGuard: Binding<WriteGuard>?, _ write: (APIClient) async throws -> Void) async {
        guard !busy, let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            try await write(client)
            writeGuard?.wrappedValue.didSucceed()
            await onDone()
            dismiss()
        } catch {
            writeGuard?.wrappedValue.didFail(error)
            self.error = writeGuard?.wrappedValue.unresolved == true ? "Couldn't confirm the save. Try again." : errorMessage(error)
        }
    }
}
