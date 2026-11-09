import HermesKit
import SwiftUI

/// Edits a saved body's fields; `save` gets the new body and the write's idempotency key.
struct EditForm<B: Equatable>: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.profileDrafting) private var drafting
    let title: String
    let fields: [DraftField<B>]
    let original: B
    let save: @MainActor (B, String) async throws -> Void
    /// why Save stays off though every field parses (a pay stub that doesn't balance)
    let check: (B) -> String?
    @State private var texts: [String: String]
    @State private var writes = WriteGuard()
    @State private var busy = false
    @State private var error: String?

    init(title: String, fields: [DraftField<B>], original: B, check: @escaping (B) -> String? = { _ in nil },
         save: @escaping @MainActor (B, String) async throws -> Void) {
        self.title = title
        self.fields = fields
        self.original = original
        self.check = check
        self.save = save
        _texts = State(initialValue: DraftField.texts(fields, original))
    }

    var body: some View {
        let edited = DraftField.build(fields, texts, original)
        let problem = edited.flatMap(check)
        Sheet(title: title, canSave: !busy && edited != nil && problem == nil && edited != original, busy: busy,
              unresolved: writes.unresolved, dirty: edited != original,
              onCancel: { dismiss() }, onSave: { Task { await submit() } }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section { DraftFields(fields: fields, texts: $texts, uncertain: []) }.disabled(busy || writes.unresolved)
            if let problem { Section { Text(problem).textStyle(.caption, color: Palette.loss) } }
            if let error { Section { InlineError(message: error) } }
        }
        .onChange(of: edited != original) { _, dirty in drafting.wrappedValue = dirty }
        .onDisappear { drafting.wrappedValue = false }
    }

    private func submit() async {
        guard let edited = DraftField.build(fields, texts, original) else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            try await save(edited, writes.key)
            writes.didSucceed()
            dismiss()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the save. Tap Save to retry; it won't be applied twice." : errorMessage(error)
        }
    }
}

/// A row that opens its saved fields in an edit form.
struct EditRow<B: Equatable, Row: View>: View {
    let title: String
    let fields: [DraftField<B>]
    let original: B
    var check: (B) -> String? = { _ in nil }
    let row: Row
    let save: @MainActor (B, String) async throws -> Void
    @State private var editing = false

    var body: some View {
        // plain: a link or unlink button beside it in the row keeps its own taps
        Button { editing = true } label: { row }
            .buttonStyle(.plain)
            .sheet(isPresented: $editing) { EditForm(title: title, fields: fields, original: original, check: check, save: save) }
    }
}

/// About me: a fixed short list and a note.
struct AboutMeForm: View {
    @Environment(AppModel.self) private var model
    let profile: Profile
    let onSaved: () async -> Void

    var body: some View {
        EditForm(title: "About me", fields: Self.fields, original: profile) { body, key in
            guard let client = model.client else { return }
            _ = try await client.putProfile(body, from: profile, idempotencyKey: key)
            await onSaved()
        }
    }

    static let retirementKinds: [(value: String, label: String)] = [("pre_tax", "Pre-tax"), ("roth", "Roth"), ("mixed", "Mixed")]

    private static let fields: [DraftField<PutProfileBody>] = [
        .init(key: "state", label: "State code", kind: .code(\.state)),
        .init(key: "filingStatus", label: "Filing status", kind: .choice(\.filingStatus, ProfileDraftForm.filingStatuses)),
        .init(key: "birthYear", label: "Birth year", kind: .whole(\.birthYear)),
        .init(key: "dependents", label: "Dependents", kind: .whole(\.dependents)),
        .init(key: "retirementPct", label: "Retirement contribution %", kind: .number(\.retirementPct)),
        .init(key: "retirementKind", label: "Retirement contributions", kind: .choice(\.retirementKind, retirementKinds)),
        .init(key: "hsa", label: "Health savings account", kind: .flag(\.hsa)),
        .init(key: "fullTimeStudent", label: "Full-time student this year", kind: .flag(\.fullTimeStudent)),
        .init(key: "claimedAsDependent", label: "Someone can claim me as a dependent this year", kind: .flag(\.claimedAsDependent)),
        .init(key: "note", label: "Note", kind: .text(\.note)),
    ]
}
