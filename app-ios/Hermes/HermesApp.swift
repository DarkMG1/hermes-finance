import SwiftUI

enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: Self { self }
    var title: String { rawValue.capitalized }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

@main
struct HermesApp: App {
    @State private var model: AppModel
    @AppStorage("appearance") private var appearance = Appearance.system
    @AppStorage("requireFaceID") private var requireFaceID = true
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var lock: AppLock

    init() {
        let model = AppModel()
        _model = State(initialValue: model)
        _lock = State(initialValue: AppLock {
            UserDefaults.standard.set(true, forKey: "faceIDChanged")
            model.disconnect()
        })
        // an x to clear a single-line text field (payee, account name, ...)
        UITextField.appearance().clearButtonMode = .whileEditing
        UserDefaults.standard.set(true, forKey: "hideBalances")
    }

    private var importReady: Bool {
        lock.canImportDocuments && !model.csvImports.files.isEmpty && !model.csvImports.busy && model.importNote == nil
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if model.reader == nil { ConnectView() } else { MainTabs() }
            }
            .environment(model)
            .environment(lock)
            .environment(model.receiptQueue)
            .tint(Palette.accent)
            .preferredColorScheme(appearance.colorScheme)
            .onOpenURL { model.queueCSV(.success($0)) }
            .onChange(of: importReady, initial: true) { _, ready in
                if ready { Task { await model.importCSV(ready: lock.canImportDocuments) } }
            }
            .alert("Apple Card import", isPresented: Binding(
                get: { lock.canImportDocuments && model.importNote != nil },
                set: { if !$0 { model.importNote = nil } }
            )) {
                Button("OK", role: .cancel) { model.importNote = nil }
            } message: {
                Text(model.importNote ?? "")
            }
            .task {
                await model.refreshReferenceData(coalescing: true)
            }
            .onChange(of: model.reader != nil) { _, connected in
                if connected { lock.didConnect(enabled: requireFaceID) }
            }
            .onChange(of: scenePhase, initial: true) { _, phase in
                // balances hide whenever Hermes leaves the screen; showing them again needs Face ID
                if phase == .background { UserDefaults.standard.set(true, forKey: "hideBalances") }
                if phase == .active { model.loadStoredConnection() }
                if phase == .active { Task { await model.receiptQueue.retryAll(client: model.client) } }
                lock.phaseChanged(to: phase, enabled: requireFaceID, connected: model.reader != nil)
            }
        }
    }
}

struct MainTabs: View {
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: 0) { NavigationStack { HomeView() } }
            Tab("Spending", systemImage: "chart.bar", value: 1) { NavigationStack { SpendingView() } }
            Tab("Activity", systemImage: "list.bullet", value: 2) { NavigationStack { ActivityView() } }
            Tab("Settings", systemImage: "gearshape", value: 3) { NavigationStack { SettingsView() } }
        }
        .environment(\.selectedTab, tab)
        .onChange(of: QuickActions.shared.snapRequests) { tab = 0 }
    }
}

extension EnvironmentValues {
    /// Tabs keep their navigation stacks, so a screen that must forget something on leaving watches this.
    @Entry var selectedTab = 0
}
