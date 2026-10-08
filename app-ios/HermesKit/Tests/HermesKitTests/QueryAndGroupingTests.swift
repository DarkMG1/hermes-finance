import Foundation
import Testing
@testable import HermesKit
@testable import struct HermesKit.Category

@Test func queryItemsSkipEmptyFiltersAndCapSearch() {
    let long = String(repeating: "a", count: 150)
    let q = TransactionQuery(accountId: "a1", categoryId: nil, q: "  \(long)  ", cursor: "c1")
    #expect(q.items == [
        URLQueryItem(name: "accountId", value: "a1"), URLQueryItem(name: "q", value: String(repeating: "a", count: 100)),
        URLQueryItem(name: "cursor", value: "c1"), URLQueryItem(name: "limit", value: "50"),
    ])
    #expect(TransactionQuery(q: "   ").items == [URLQueryItem(name: "limit", value: "50")])
}

@Test func groupsSortsFiltersAndHidesHidden() {
    let cats = [
        Category(id: "1", name: "Synthetic Rent", groupName: "Synthetic Home"),
        Category(id: "2", name: "Synthetic Cafe", groupName: "Synthetic Food"),
        Category(id: "3", name: "Synthetic Bakery", groupName: "Synthetic Food"),
        Category(id: "4", name: "Synthetic Old", groupName: "Synthetic Food", hidden: true),
    ]
    let all = CategoryGrouping.group(cats, matching: "")
    #expect(all.map(\.name) == ["Synthetic Food", "Synthetic Home"])
    #expect(all[0].items.map(\.name) == ["Synthetic Bakery", "Synthetic Cafe"])
    #expect(CategoryGrouping.group(cats, matching: "cafe").flatMap(\.items).map(\.id) == ["2"])
    #expect(CategoryGrouping.group(cats, matching: "home").flatMap(\.items).map(\.id) == ["1"])
}

@Test func accountsGroupInFixedOrderAndCreditCountsAsOwed() {
    func account(_ id: String, _ name: String, _ type: String, _ cents: Int?, hidden: Bool = false) -> Account {
        Account(id: id, name: name, mask: nil, type: type, subtype: nil, balanceCurrentCents: cents,
                balanceAvailableCents: nil, balanceAt: nil, hidden: hidden, itemId: nil)
    }
    let groups = AccountGrouping.group([
        account("1", "Synthetic Card", "credit", 500), account("2", "Synthetic Brokerage", "investment", 100),
        account("3", "Synthetic Savings", "depository", 200), account("4", "Synthetic Checking", "depository", 300),
        account("5", "Synthetic Old", "depository", 1, hidden: true), account("6", "Synthetic Misc", "other", nil),
    ])
    #expect(groups.map(\.name) == ["Cash", "Credit", "Investments", "Other"])
    #expect(groups[0].accounts.map(\.id) == ["4", "3"])
    #expect(AccountGrouping.netWorthCents(groups[1].accounts[0]) == -500)
    #expect(AccountGrouping.netWorthCents(groups[0].accounts[0]) == 300)
    #expect(AccountGrouping.netWorthCents(groups[3].accounts[0]) == nil)
}
