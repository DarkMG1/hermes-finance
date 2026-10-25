import AuthenticationServices
import HermesKit
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuth
    @AppStorage("appearance") private var appearance = Appearance.system
    @AppStorage("requireFaceID") private var requireFaceID = true
    @State private var banks: LoadState<[Bank]> = .loading
    @State private var linker = BankLinker()
    @State private var syncWrites = WriteGuard()
    @State private var syncing = false
    @State private var syncNote: String?
    @State private var importing = false
    @State private var confirmDisconnect = false
    @State private var serverSha: String?

    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Hermes \(version) (\(build))" + (serverSha.map { " · server \($0.prefix(7))" } ?? "")
    }

    var body: some View {
        Form {
            Section("Banks") {
                // swiftlint:disable:next multiple_closures_with_trailing_closure
                LoadingContent(state: banks, retry: { Task { await loadBanks() } }) { loaded in
                    ForEach(loaded.value) { bank in
                        ListRow(title: bank.institutionName, subtitle: subtitle(for: bank)) {
                            if bank.status != "ok" {
                                Button("Reconnect") {
                                    Task {
                                        await linker.reconnect(itemId: bank.itemId, model: model, authenticate: authenticate)
                                        await loadBanks()
                                    }
                                }
                                .buttonStyle(.borderless)
                                .disabled(linker.busy)
                            }
                        }
                    }
                }
                Button {
                    Task {
                        await linker.add(model: model, authenticate: authenticate)
                        await loadBanks()
                    }
                } label: {
                    HStack { Label("Add bank", systemImage: "plus"); Spacer(); if linker.busy { ProgressView() } }
                }
                .disabled(linker.busy)
                InlineError(message: linker.error)
                if let note = linker.note { Text(note).textStyle(.caption, color: Palette.secondaryText) }
            }
            Section("Sync") {
                Button { Task { await syncNow() } } label: {
                    HStack { Text("Sync now"); Spacer(); if syncing { ProgressView() } }
                }
                .disabled(syncing)
                if let syncNote { Text(syncNote).textStyle(.caption, color: Palette.secondaryText) }
            }
            Section {
                NavigationLink { ReconcileView() } label: { Label("Reconcile", systemImage: "checkmark.circle") }
            }
            Section {
                Button { importing = true } label: {
                    HStack { Text("Import Apple Card CSV"); Spacer(); if model.csvImports.busy { ProgressView() } }
                }
                .disabled(!model.csvImports.files.isEmpty)
            } header: {
                Text("Apple Card")
            } footer: {
                Text("In Wallet: Apple Card → Card Balance → a statement → Export Transactions. Importing the same statement twice is safe.")
            }
            Section {
                Toggle("Require Face ID", isOn: Binding(
                    get: { requireFaceID },
                    set: { on in
                        if on {
                            requireFaceID = true
                        } else {
                            Task {
                                switch await AppLock.confirmOwner(reason: "Turn off Face ID for Hermes", allowNewBaseline: false) {
                                case .confirmed: requireFaceID = false
                                case .failed: break
                                case .facesChanged:
                                    UserDefaults.standard.set(true, forKey: "faceIDChanged")
                                    model.disconnect()
                                }
                            }
                        }
                    }
                ))
                    .disabled(!AppLock.canUseFaceID)
            } header: {
                Text("Security")
            } footer: {
                Text(AppLock.canUseFaceID
                     ? "Asks when Hermes opens and after \(Int(LockPolicy.grace)) seconds away."
                     : AppLock.hasBiometricHardware
                     ? "Face ID is unavailable right now. Hermes stays locked until it works again."
                     : "Set up Face ID in iOS Settings to lock Hermes.")
            }
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            Section {
                LabeledContent("Address", value: model.serverURL)
                Button("Disconnect", role: .destructive) { confirmDisconnect = true }
                    .confirmationDialog("Disconnect from this server?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
                        Button("Disconnect", role: .destructive) { model.disconnect() }
                    }
            } header: {
                Text("Server")
            } footer: {
                Text(versionText).textStyle(.caption, color: Palette.secondaryText)
            }
        }
        .themedForm()
        // the version footer sits last, under the floating tab bar, unless the scroll can go a little further
        .contentMargins(.bottom, Space.xl, for: .scrollContent)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task { serverSha = try? await model.reader?.read("/v1/health", as: Health.self).value.gitSha }
        .task { await loadBanks() }
        .refreshable { await loadBanks() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.commaSeparatedText]) { result in
            model.queueCSV(result)
        }
    }

    private func authenticate(_ url: URL) async throws -> URL {
        try await webAuth.authenticate(using: url, callback: .customScheme(HermesKit.callbackScheme),
                                       preferredBrowserSession: nil, additionalHeaderFields: [:])
    }

    private func subtitle(for bank: Bank) -> String {
        switch bank.status {
        case "login_required": return "Needs you to sign in again"
        case "error": return "Sync error\(bank.lastErrorCode.map { " (\($0))" } ?? "")"
        default:
            guard let at = bank.lastSyncedAt, let date = try? Date(at, strategy: .iso8601) else { return "Not synced yet" }
            return "Synced \(date.formatted(.relative(presentation: .named)))"
        }
    }

    private func loadBanks() async {
        guard let reader = model.reader else { return }
        do {
            let loaded = try await reader.read("/v1/banks", as: [Bank].self)
            guard !Task.isCancelled else { return }
            banks = .loaded(loaded)
        } catch {
            guard !Task.isCancelled else { return }
            banks = .failed(errorMessage(error))
        }
    }

    private func syncNow() async {
        guard let client = model.client else { return }
        syncing = true
        defer { syncing = false }
        do {
            let status = try await client.sync(idempotencyKey: syncWrites.key)
            syncWrites.didSucceed()
            let added = status.items.reduce(0) { $0 + $1.added }
            let changed = status.items.reduce(0) { $0 + $1.modified + $1.removed }
            let problems = status.items.filter { $0.result != "ok" && $0.result != "already_running" }.count
            syncNote = "\(added) new, \(changed) changed" + (problems > 0 ? " · \(problems) bank(s) need attention" : "")
            await loadBanks()
        } catch {
            syncWrites.didFail(error)
            syncNote = errorMessage(error)
        }
    }
}
