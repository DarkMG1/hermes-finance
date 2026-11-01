import SwiftUI

/// While balances are hidden, Ask (chat titles included) stays covered until Face ID, so hiding still guards a glance at the screen.
/// Unlocking here shows nothing elsewhere; it lasts until leaving the tab, the background, or balances being hidden again.
struct AskLock<Content: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.selectedTab) private var selectedTab
    @AppStorage("hideBalances") private var hideBalances = true
    @State private var unlocked = false
    @State private var unlocking = false
    @State private var error: String?
    /// Bumped by every relock, so a Face ID success that lands after one doesn't unlock.
    @State private var generation = 0
    @ViewBuilder var content: Content

    var body: some View {
        let covered = hideBalances && !unlocked
        content
            .accessibilityHidden(covered)
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
            .onChange(of: scenePhase) { _, phase in if phase == .background { relock() } }
            .onChange(of: selectedTab) { relock() }
            .onChange(of: hideBalances) { _, hidden in if hidden { relock() } }
    }

    private func relock() {
        unlocked = false
        error = nil
        generation += 1
    }

    private func unlock() async {
        guard !unlocking else { return }
        unlocking = true
        defer { unlocking = false }
        let started = generation
        let check = await confirmShowBalances(lock: lock, model: model, reason: "Unlock Ask")
        guard generation == started else { return }
        unlocked = check.shown
        error = check.error
    }
}
