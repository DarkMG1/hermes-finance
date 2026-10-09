import AuthenticationServices
import HermesKit
import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var state: LoadState<Home> = .loading
    @State private var selected: LedgerTransaction?
    @State private var renaming: Account?
    @State private var linker = BankLinker()

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
                    Text("Net worth").textStyle(.subhead, color: Palette.secondaryText)
                    MoneyText(cents: loaded.value.netWorthCents, style: .display, colored: false, negativeIsLoss: true)
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
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Rename")
                            }
                        }
                    }
                }
                let home = loaded.value
                if home.owedToYouCents > 0 || home.repaymentSuggestions > 0 {
                    NavigationLink { WhoOwesView() } label: {
                        Card {
                            Text("Owed to you").textStyle(.subhead, color: Palette.secondaryText)
                            MoneyText(cents: home.owedToYouCents, style: .display, colored: false)
                            if home.repaymentSuggestions > 0 {
                                Text(home.repaymentSuggestions == 1 ? "1 possible repayment" : "\(home.repaymentSuggestions) possible repayments")
                                    .textStyle(.caption, color: Palette.accent)
                            }
                        }
                    }
                    .buttonStyle(.plain)
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
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $selected) { transaction in
            TransactionDetailSheet(transaction: transaction) { await load() }
        }
        .sheet(item: $renaming) { account in
            AccountSheet(account: account) { await model.refreshReferenceData() }
        }
    }

    private func load() async {
        guard let reader = model.reader else { return }
        do {
            let loaded = try await reader.read("/v1/home", as: Home.self)
            await model.refreshReferenceData()
            guard !Task.isCancelled else { return }
            state = .loaded(loaded)
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(errorMessage(error))
        }
    }
}
