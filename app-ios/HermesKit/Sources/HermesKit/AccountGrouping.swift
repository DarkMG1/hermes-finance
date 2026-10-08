import Foundation

public struct AccountGroup: Sendable, Hashable {
    public let name: String
    public let accounts: [Account]
}

public enum AccountGrouping {
    private static let order = ["Cash", "Credit", "Investments", "Other"]

    /// Visible accounts grouped for Home, in a fixed group order, sorted by name within a group.
    public static func group(_ accounts: [Account]) -> [AccountGroup] {
        let visible = accounts.filter { !$0.hidden }
        return Dictionary(grouping: visible, by: groupName)
            .map { AccountGroup(name: $0.key, accounts: $0.value.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) }
            .sorted { order.firstIndex(of: $0.name)! < order.firstIndex(of: $1.name)! }
    }

    /// The balance as it counts toward net worth: what you owe on credit and loans is negative.
    public static func netWorthCents(_ account: Account) -> Int? {
        guard let cents = account.balanceCurrentCents else { return nil }
        return ["credit", "loan"].contains(account.type) ? -cents : cents
    }

    private static func groupName(_ account: Account) -> String {
        switch account.type {
        case "depository": "Cash"
        case "credit", "loan": "Credit"
        case "investment": "Investments"
        default: "Other"
        }
    }
}
