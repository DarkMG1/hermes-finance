import HermesKit
import SwiftUI

struct CategoryPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String?
    /// The top row, which clears the selection.
    var noneTitle = "Uncategorized"
    var spendingOnly = false
    @State private var query = ""

    var body: some View {
        let categories = model.categories.filter { !spendingOnly || (!$0.isIncome && !$0.isTransfer) }
        List {
            Button { choose(nil) } label: { SelectionRow(title: noneTitle, selected: selection == nil) }
            ForEach(CategoryGrouping.group(categories, matching: query), id: \.name) { group in
                Section(group.name) {
                    ForEach(group.items) { category in
                        Button { choose(category.id) } label: { SelectionRow(title: category.name, selected: selection == category.id) }
                    }
                }
            }
        }
        .themedForm()
        .navigationTitle("Category")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query)
    }

    private func choose(_ id: String?) {
        selection = id
        dismiss()
    }
}
