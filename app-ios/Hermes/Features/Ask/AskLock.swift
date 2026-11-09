import SwiftUI

/// While balances are hidden, Ask (chat titles included) stays covered until Face ID, so hiding still guards a glance at the screen.
/// Unlocking here shows nothing elsewhere; it lasts until leaving the tab or balances being hidden again. A trip to the background keeps
/// it, because the app lock then asks for Face ID on return (without Face ID hardware the background relocks it instead).
/// That Face ID also unlocks the financial profile. With balances shown there is none here, but showing them took Face ID, so the
/// profile opens unlocked then too; either way it's dropped on the same relock: one per Ask visit.
struct AskLock<Content: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.selectedTab) private var selectedTab
    @AppStorage("hideBalances") private var hideBalances = true
    @State private var unlocked = false
    @State private var profileUnlocked = false
    @State private var unlocking = false
    @State private var error: String?
    /// Bumped by every relock, so a Face ID success that lands after one doesn't unlock.
    @State private var generation = 0
    /// This tab's value: opening it asks for Face ID straight away.
    let tab: Int
    @ViewBuilder var content: Content

    var body: some View {
        let covered = hideBalances && !unlocked
        // disabled: PrivacyCover's return of the keyboard to the field it took it from can't bring it up under this cover
        content
            .disabled(covered)
            .accessibilityHidden(covered)
            .environment(\.askCovered, covered)
            .environment(\.askProfileUnlocked, $profileUnlocked)
            .overlay {
                if covered {
                    VStack(spacing: Space.l) {
                        HButton(title: "Unlock with Face ID", busy: unlocking) { Task { await unlock() } }
                        if let error { Text(error).textStyle(.caption, color: Palette.secondaryText).multilineTextAlignment(.center) }
                    }
                    .padding(Space.xxl)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Palette.background)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .background else { return }
                // the app lock's Face ID on return stands for this one; balances hidden on the way out mustn't cover Ask behind it
                if (unlocked || profileUnlocked) && AppLock.hasBiometricHardware { unlocked = true } else { relock() }
            }
            .onChange(of: unlocked || profileUnlocked, initial: true) { _, open in lock.askOpen = open }
            // initial: the tab's content first appears with this tab already selected
            .onChange(of: selectedTab, initial: true) { _, selected in
                relock()
                guard selected == tab else { return }
                if hideBalances { Task { await unlock() } } else { profileUnlocked = true }
            }
            // leaving hides balances; an open Ask stays open behind the app lock instead
            .onChange(of: hideBalances) { _, hidden in
                if hidden, !(lock.askOpen && UIApplication.shared.applicationState == .background) { relock() }
            }
    }

    private func relock() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        unlocked = false
        profileUnlocked = false
        error = nil
        generation += 1
    }

    private func unlock() async {
        guard !unlocking else { return }
        unlocking = true
        let started = generation
        let check = await confirmShowBalances(lock: lock, model: model, reason: "Unlock Ask")
        unlocking = false
        guard generation == started else {
            // a tab switch during the prompt asked again while this one was up and was ignored: ask now if Ask is still showing
            if selectedTab == tab, hideBalances, !unlocked, scenePhase != .background { await unlock() }
            return
        }
        unlocked = check.shown
        profileUnlocked = check.shown
        error = check.error
    }
}

extension EnvironmentValues {
    /// The navigation bar is UIKit's and VoiceOver reads it past `accessibilityHidden`, so a covered screen hides it.
    @Entry var askCovered = false
    /// Face ID passed for the financial profile this Ask visit: questions may use it and answers that did show.
    @Entry var askProfileUnlocked: Binding<Bool> = .constant(false)
}
