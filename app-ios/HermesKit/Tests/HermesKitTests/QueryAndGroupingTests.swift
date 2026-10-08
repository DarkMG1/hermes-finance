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
