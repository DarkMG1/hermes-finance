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
    @State private var model = AppModel()
    @AppStorage("appearance") private var appearance = Appearance.system

    init() {
        // an x to clear a single-line text field (payee, account name, ...)
        UITextField.appearance().clearButtonMode = .whileEditing
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if model.reader == nil { ConnectView() } else { MainTabs() }
            }
            .environment(model)
            .tint(Palette.accent)
            .preferredColorScheme(appearance.colorScheme)
            .task { await model.refreshReferenceData() }
        }
    }
}

struct MainTabs: View {
    var body: some View {
        TabView {
            Tab("Home", systemImage: "house") { NavigationStack { HomeView() } }
            Tab("Spending", systemImage: "chart.bar") { NavigationStack { SpendingView() } }
            Tab("Activity", systemImage: "list.bullet") { NavigationStack { ActivityView() } }
            Tab("Settings", systemImage: "gearshape") { NavigationStack { SettingsView() } }
        }
    }
}
