import HermesKit
import SwiftUI

/// Face ID on every open, even with the app lock off. Nothing under it is built, or loaded, until then. While it's open the app
/// lock asks for Face ID on any return from the background, so a read or an edit survives a trip to another app; without
/// biometric hardware to lock with, going to the background tears it down again (its screens and their data).
struct ProfileGate: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var unlocked = false
    @State private var unlocking = false
    @State private var error: String?
    /// a read or an edit is open: the relock throws it away, and says so
    @State private var drafting = false

    var body: some View {
        NavigationStack {
            if unlocked {
                ProfileView().environment(\.profileDrafting, $drafting)
            } else {
                VStack(spacing: Space.l) {
                    HButton(title: "Unlock with Face ID", busy: unlocking) { Task { await unlock() } }
                    if let error { Text(error).textStyle(.caption, color: Palette.secondaryText).multilineTextAlignment(.center) }
                }
                .padding(Space.xxl)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.background)
                .navigationTitle("Financial profile")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            }
        }
        .task { await unlock() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .background, !(unlocked && AppLock.hasBiometricHardware) else { return }
            // security over the draft: the relock drops it, but the owner hears why it's gone
            error = unlocked && drafting ? "Locked — your unsaved draft was discarded" : nil
            unlocked = false
        }
        .onChange(of: lock.canImportDocuments && model.openedPDF != nil) { _, waiting in
            if waiting, !unlocked { Task { await unlock() } }
        }
        .onChange(of: unlocked) { _, open in lock.profileOpen = open }
        .onAppear { model.profileGateOpen = true }
        .onDisappear {
            lock.profileOpen = false
            model.openedPDF = nil
            model.profileGateOpen = false
        }
    }

    private func unlock() async {
        guard !unlocking else { return }
        if model.openedPDF != nil, lock.justUnlocked {
            unlocked = true
            error = nil
            return
        }
        unlocking = true
        defer { unlocking = false }
        // confirmOwnerInApp fails a prompt that outlives a trip to the background
        let check = await confirmShowBalances(lock: lock, model: model, reason: "Open financial profile")
        unlocked = check.shown
        if check.shown || check.error != nil { error = check.error }
    }
}

struct ProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var profile: Profile?
    @State private var jobs: [Job]?
    @State private var jobless: [PayStub] = []
    @State private var error: String?
    @State private var editingAboutMe = false
    @State private var adding: CaptureRequest?
    @State private var addingJob = false

    var body: some View {
        List {
            InlineError(message: error)
            if let pdf = model.openedPDF {
                Section("What is this PDF?") {
                    ForEach(ProfileKind.allCases, id: \.self) { kind in
                        Button(kind.title) {
                            adding = CaptureRequest(kind: kind, source: .pdf, opened: pdf)
                            model.openedPDF = nil
                        }
                    }
                    Button("Discard", role: .destructive) { model.openedPDF = nil }
                }
            } else {
                Section("About me") {
                    if let profile {
                        Button { editingAboutMe = true } label: { ListRow(title: "About me", subtitle: Self.summary(profile)) }
                            .foregroundStyle(Palette.text)
                    } else if error == nil {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                if let jobs {
                    ForEach(Self.statuses, id: \.value) { status in
                        let group = jobs.filter { $0.status == status.value }
                        if !group.isEmpty {
                            Section(status.label) {
                                ForEach(group) { job in
                                    NavigationLink { JobDetailView(id: job.id) { await load() } } label: {
                                        ListRow(title: job.employer ?? "Job", subtitle: job.title)
                                    }
                                    .deleteSwipe("Delete this job and its grants?") { client, key in
                                        try await client.deleteJob(id: job.id, idempotencyKey: key)
                                        await load()
                                    }
                                }
                            }
                        }
                    }
                    if jobs.isEmpty {
                        Section("Jobs & offers") {
                            Text("Add an offer letter with +.").textStyle(.subhead, color: Palette.secondaryText)
                        }
                    }
                    if !jobless.isEmpty {
                        // saved before any job matched, or left when their job was deleted
                        Section("Pay stubs without a job") {
                            ForEach(jobless) {
                                PayStubRow(stub: $0, fields: [ProfileDraftForm.stubJobField(jobs)] + ProfileDraftForm.stubFields) { await load() }
                            }
                        }
                    }
                }
                Section {
                    NavigationLink { TaxYearsView() } label: { Text("Tax years") }
                }
            }
        }
        .themedForm()
        .navigationTitle("Financial profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ForEach(ProfileKind.allCases, id: \.self) { kind in
                        Menu(kind.title) {
                            ForEach(CaptureSource.available, id: \.self) { source in
                                Button(source.title) { adding = CaptureRequest(kind: kind, source: source) }
                            }
                        }
                    }
                    Divider()
                    Button("Job, entered by hand") { addingJob = true }
                } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add document")
            }
        }
        .profileCapture($adding) { await load() }
        .sheet(isPresented: $addingJob) {
            EditForm(title: "New job", fields: JobDetailView.fields, original: Self.newJob) { body, key in
                _ = try await model.client?.createJob(body, idempotencyKey: key)
                await load()
            }
        }
        .sheet(isPresented: $editingAboutMe) {
            if let profile { AboutMeForm(profile: profile) { await load() } }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            async let p = client.profile()
            async let j = client.jobs()
            async let s = client.unassignedPayStubs()
            (profile, jobs, jobless) = try await (p, j, s)
            error = nil
        } catch {
            self.error = errorMessage(error)
        }
    }

    private static let newJob = { var j = CreateJobBody(); j.status = "current"; return j }()

    static let statuses: [(value: String, label: String)] = [
        ("current", "Current"), ("accepted", "Accepted"), ("offered", "Offers"), ("past", "Past"), ("declined", "Declined"),
    ]

    private static func summary(_ p: Profile) -> String {
        let parts = [
            p.filingStatus.flatMap { s in ProfileDraftForm.filingStatuses.first { $0.value == s }?.label },
            p.state,
            p.birthYear.map { "born \($0)" },
            p.dependents.map { $0 == 1 ? "1 dependent" : "\($0) dependents" },
        ].compactMap { $0 }
        return parts.isEmpty ? "Not filled in" : parts.joined(separator: " · ")
    }
}

extension EnvironmentValues {
    /// Set while a read or an edit is open under the profile gate.
    @Entry var profileDrafting: Binding<Bool> = .constant(false)
}

extension View {
    /// Swipe to delete, after a confirmation that sits on the row; `delete` gets the write's idempotency key.
    func deleteSwipe(_ title: String, delete: @escaping (APIClient, String) async throws -> Void) -> some View {
        modifier(DeleteSwipe(title: title, delete: delete))
    }
}

private struct DeleteSwipe: ViewModifier {
    @Environment(AppModel.self) private var model
    let title: String
    let delete: (APIClient, String) async throws -> Void
    @State private var confirming = false
    @State private var writes = WriteGuard()
    @State private var error: String?

    func body(content: Content) -> some View {
        content
            .swipeActions { Button("Delete", role: .destructive) { confirming = true } }
            .confirmationDialog(title, isPresented: $confirming, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { await run() } }
            }
            .alert(error ?? "", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {}
    }

    private func run() async {
        guard let client = model.client else { return }
        do {
            try await delete(client, writes.key)
            writes.didSucceed()
        } catch {
            writes.didFail(error)
            self.error = writes.unresolved ? "Couldn't confirm the delete. Delete again to retry; it won't be applied twice." : errorMessage(error)
        }
    }
}
