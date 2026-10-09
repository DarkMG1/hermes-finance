import HermesKit
import SwiftUI

/// Add a person (person == nil) or edit one: name, how they appear on Zelle, archive once settled.
struct PersonSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let person: Person?
    let onDone: (Person?) async -> Void

    @State private var name = ""
    @State private var matchText = ""
    @State private var writes = WriteGuard()
    @State private var archiveWrites = WriteGuard()
    @State private var error: String?
    @State private var busy = false
    @State private var confirmArchive = false

    var body: some View {
        Sheet(
            title: person == nil ? "New person" : "Person", saveTitle: person == nil ? "Add" : "Save", canSave: canSave, busy: busy,
            unresolved: writes.unresolved || archiveWrites.unresolved,
            onCancel: { if writes.unresolved || archiveWrites.unresolved { Task { await onDone(nil) } }; dismiss() },
            onSave: { Task { await save() } }
        ) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "Name", error: error) { TextField("Name", text: $name) }
                Field(label: "How they appear on Zelle") { TextField("Optional", text: $matchText).textInputAutocapitalization(.characters) }
            } footer: {
                Text("Hermes uses this to suggest which deposits are their repayments.")
            }
            .disabled(writes.unresolved || archiveWrites.unresolved)
            if let person {
                Section {
                    HButton(title: "Archive", kind: .destructive, busy: busy) { confirmArchive = true }
                        .disabled(person.balanceCents != 0 || writes.unresolved)
                        .confirmationDialog("Archive \(person.name)? They'll be hidden from pickers.", isPresented: $confirmArchive,
                                            titleVisibility: .visible) {
                            Button("Archive", role: .destructive) { Task { await archive(person) } }
                        }
                } footer: {
                    if person.balanceCents != 0 { Text("You can archive someone once they're settled up.") }
                }
            }
        }
        .onAppear {
            name = person?.name ?? ""
            matchText = person?.matchText ?? ""
        }
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedMatch: String { matchText.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSave: Bool {
        guard !trimmedName.isEmpty, !archiveWrites.unresolved else { return false }
        guard let person else { return true }
        return trimmedName != person.name || trimmedMatch != (person.matchText ?? "")
    }

    private func save() async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            let match = trimmedMatch.isEmpty ? nil : trimmedMatch
            let result: Person
            if let person {
                result = try await client.patchPerson(id: person.id, body: PatchPersonBody(name: trimmedName, matchText: .set(match)),
                                                      idempotencyKey: writes.key)
            } else {
                result = try await client.createPerson(CreatePersonBody(name: trimmedName, matchText: match), idempotencyKey: writes.key)
            }
            writes.didSucceed()
            await model.refreshReferenceData()
            await onDone(result)
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry." : errorMessage(error)
        }
    }

    private func archive(_ person: Person) async {
        guard let client = model.client else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await client.patchPerson(id: person.id, body: PatchPersonBody(archived: true), idempotencyKey: archiveWrites.key)
            archiveWrites.didSucceed()
            await model.refreshReferenceData()
            await onDone(result)
            dismiss()
        } catch {
            archiveWrites.didFail(error)
            self.error = archiveWrites.unresolved ? "Couldn't confirm. Try again." : errorMessage(error)
        }
    }
}
