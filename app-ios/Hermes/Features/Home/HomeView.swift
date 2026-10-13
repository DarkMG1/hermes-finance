import AuthenticationServices
import HermesKit
import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @Environment(ReceiptQueue.self) private var queue
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var state: LoadState<Home> = .loading
    @State private var investments: Investments?
    @State private var selected: LedgerTransaction?
    @State private var renaming: Account?
    @State private var linker = BankLinker()
    @AppStorage("hideBalances") private var hideBalances = true
    @State private var showingBalances = false
    @State private var showBalancesError: String?
    @State private var inboxCount = 0
    @State private var snapping = false
    @State private var showingInbox = false
    @State private var handledSnaps = 0

    var body: some View {
        Screen(title: "Home") {
            // swiftlint:disable:next multiple_closures_with_trailing_closure
            LoadingContent(state: state, retry: { Task { await load() } }) { loaded in
                LastUpdated(loaded: loaded)
                ForEach(loaded.value.reconnect) { item in
                    Card {
                        Text("\(item.institutionName) needs you to sign in again").textStyle(.headline)
                        HButton(title: "Reconnect \(item.institutionName)", busy: linker.busy) {
                            Task {
                                await linker.reconnect(itemId: item.itemId, model: model) { url in
                                    try await webAuth.authenticate(using: url, callback: .customScheme(HermesKit.callbackScheme),
                                                                   preferredBrowserSession: nil, additionalHeaderFields: [:])
                                }
                                await load()
                            }
                        }
                        InlineError(message: linker.error)
                    }
                }
                if let note = linker.note { Text(note).textStyle(.caption, color: Palette.secondaryText) }
                Card {
                    HStack {
                        Text("Net worth").textStyle(.subhead, color: Palette.secondaryText)
                        Spacer()
                        Button {
                            if hideBalances {
                                Task { await showBalances() }
                            } else {
                                hideBalances = true
                            }
                        } label: {
                            Image(systemName: hideBalances ? "eye" : "eye.slash")
                        }
                        .accessibilityLabel(hideBalances ? "Show balances" : "Hide balances")
                    }
                    MoneyText(cents: loaded.value.netWorthCents, style: .display, colored: false, negativeIsLoss: true)
                        .redacted(reason: hideBalances ? .placeholder : [])
                    // a row, not the whole card, so the eye button keeps its own tap
                    NavigationLink { NetWorthView() } label: {
                        ListRow(title: "History") { Image(systemName: "chevron.right").textStyle(.caption, color: Palette.secondaryText) }
                    }
                    .buttonStyle(.plain)
                }
                if let showBalancesError { Text(showBalancesError).textStyle(.caption, color: Palette.secondaryText) }
                if let due = loaded.value.toReconcile {
                    NavigationLink { ReconcileView(month: due.month) } label: {
                        Card {
                            Text("Reconcile").textStyle(.subhead, color: Palette.secondaryText)
                            ListRow(title: "\(ReconcileMonth.title(due.month)): \(due.open) to reconcile") {
                                Image(systemName: "chevron.right").textStyle(.caption, color: Palette.secondaryText)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
                if let investments, hasInvestments || !investments.reconnect.isEmpty {
                    investmentsCard(investments, signInAgain: loaded.value.reconnect)
                }
                let groups = AccountGrouping.group(model.accounts)
                if !groups.isEmpty {
                    Card {
                        Text("Accounts").textStyle(.headline)
                        ForEach(groups, id: \.name) { group in
                            Text(group.name).textStyle(.subhead, color: Palette.secondaryText)
                            ForEach(group.accounts) { account in
                                Button { renaming = account } label: {
                                    ListRow(title: account.name, subtitle: AccountGrouping.subtitle(account)) {
                                        if let cents = AccountGrouping.netWorthCents(account) {
                                            MoneyText(cents: cents, colored: false, negativeIsLoss: true)
                                                .redacted(reason: hideBalances ? .placeholder : [])
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Rename")
                            }
                        }
                    }
                }
                Card {
                    Text("Recent").textStyle(.headline)
                    if loaded.value.recent.isEmpty {
                        Text("No transactions yet").textStyle(.subhead, color: Palette.secondaryText)
                    }
                    ForEach(loaded.value.recent) { transaction in
                        Button { selected = transaction } label: { TransactionRow(transaction: transaction) }
                            .buttonStyle(.plain)
                        if transaction.id != loaded.value.recent.last?.id { Divider().overlay(Palette.separator) }
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink { WhoOwesView() } label: {
                    Image(systemName: "person.2").padding(Space.s).overlay(alignment: .topTrailing) { CountBadge(count: repayments) }
                }
                    .accessibilityLabel("IOUs")
                    .accessibilityValue(repayments > 0 ? "\(repayments) possible repayments" : "")
            }
            ToolbarItem(placement: .topBarTrailing) {
                // same flag as the quick action, so a snap while the inbox is open doesn't push a second one
                Button { showingInbox = true } label: {
                    Image(systemName: "tray").padding(Space.s).overlay(alignment: .topTrailing) { CountBadge(count: badgeCount) }
                }
                    .accessibilityLabel("Receipt inbox")
                    .accessibilityValue(badgeCount > 0 ? "\(badgeCount) waiting" : "")
            }
        }
        .refreshable { await queue.retryAll(client: model.client); await load(); await loadInbox() }
        .task { await load() }
        .task { await loadInbox() }
        .task { await queue.retryAll(client: model.client) }
        .onChange(of: queue.pending.count) { Task { await loadInbox() } }
        // outside the loaded state, so snapping works offline or when Home fails to load
        .onChange(of: QuickActions.shared.snapRequests, initial: true) { _, requests in
            guard requests > handledSnaps, model.client != nil else { return }
            handledSnaps = requests
            snapping = true
        }
        .receiptCamera(isPresented: $snapping, scanDirectly: true) { showingInbox = true }
        .navigationDestination(isPresented: $showingInbox) { InboxView() }
        .sheet(item: $selected) { transaction in
            TransactionDetailSheet(transaction: transaction) { await load() }
        }
        .sheet(item: $renaming) { account in
            AccountSheet(account: account) { await model.refreshReferenceData() }
        }
    }

    private var badgeCount: Int { inboxCount + queue.pending.count }

    private var repayments: Int {
        if case .loaded(let loaded) = state { loaded.value.repaymentSuggestions } else { 0 }
    }

    private var hasInvestments: Bool { model.accounts.contains { $0.type == "investment" && !$0.hidden } }

    @ViewBuilder private func investmentsCard(_ investments: Investments, signInAgain: [ReconnectItem]) -> some View {
        NavigationLink { InvestmentsView() } label: {
            Card {
                Text("Investments").textStyle(.subhead, color: Palette.secondaryText)
                MoneyText(cents: investments.totalCents, style: .display, colored: false, negativeIsLoss: true)
                    .redacted(reason: hideBalances ? .placeholder : [])
                GainText(gainCents: investments.gainCents, percent: investments.gainPercent)
                // the same cue as net worth's History row; the whole card opens Investments
                ListRow(title: "Holdings") { Image(systemName: "chevron.right").textStyle(.caption, color: Palette.secondaryText) }
            }
        }
        .buttonStyle(.plain)
        // a bank already asking to sign in again has its own card above
        ForEach(investments.reconnect.filter { item in !signInAgain.contains { $0.itemId == item.itemId } }) { item in
            Card {
                HButton(title: "Reconnect \(item.institutionName) to show holdings", busy: linker.busy) {
                    Task {
                        await linker.reconnect(itemId: item.itemId, model: model) { url in
                            try await webAuth.authenticate(using: url, callback: .customScheme(HermesKit.callbackScheme),
                                                           preferredBrowserSession: nil, additionalHeaderFields: [:])
                        }
                        await load()
                    }
                }
                InlineError(message: linker.error)
            }
        }
    }

    private func showBalances() async {
        guard !showingBalances else { return }
        showingBalances = true
        defer { showingBalances = false }
        showBalancesError = nil
        let check = await confirmShowBalances(lock: lock, model: model)
        if check.shown { hideBalances = false }
        showBalancesError = check.error
    }

    private func loadInbox() async {
        guard let list = try? await model.client?.inbox() else { return }
        inboxCount = list.waiting.count + list.recentlyLinked.count
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            let loaded = try await reader.read("/v1/home", as: Home.self)
            await model.refreshReferenceData()
            let loadedInvestments = try? await reader.read("/v1/investments", as: Investments.self).value
            guard !Task.isCancelled else { return }
            state = .loaded(loaded)
            investments = loadedInvestments
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(errorMessage(error))
        }
    }
}

/// Showing hidden amounts needs Face ID wherever the hardware exists, even with the app lock off: hiding guards a glance at the screen.
/// A changed face set signs out. `error` is the failure to show, if any.
@MainActor func confirmShowBalances(lock: AppLock, model: AppModel) async -> (shown: Bool, error: String?) {
    guard AppLock.hasBiometricHardware else { return (true, nil) }
    switch await lock.confirmOwnerInApp(reason: "Show balances") {
    case .confirmed: return (true, nil)
    case .failed(let message):
        if let message { AccessibilityNotification.Announcement(message).post() }
        return (false, message)
    case .facesChanged:
        UserDefaults.standard.set(true, forKey: "faceIDChanged")
        model.disconnect()
        return (false, nil)
    }
}
