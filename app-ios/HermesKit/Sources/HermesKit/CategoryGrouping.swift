import Foundation

public struct CategoryGroup: Sendable, Hashable {
    public let name: String
    public let items: [Category]
}

public enum CategoryGrouping {
    public static func group(_ categories: [Category], matching query: String) -> [CategoryGroup] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let visible = categories.filter {
            !$0.hidden && (q.isEmpty || $0.name.lowercased().contains(q) || $0.groupName.lowercased().contains(q))
        }
        let ordered: (String, String) -> Bool = { $0.localizedStandardCompare($1) == .orderedAscending }
        return Dictionary(grouping: visible, by: \.groupName)
            .map { CategoryGroup(name: $0.key, items: $0.value.sorted { ordered($0.name, $1.name) }) }
            .sorted { ordered($0.name, $1.name) }
    }
}
