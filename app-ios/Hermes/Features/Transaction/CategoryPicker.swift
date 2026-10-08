import HermesKit
import SwiftUI

struct CategoryPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String?
    @State private var query = ""

    var body: some View {
        List {
            Button { choose(nil) } label: { row("Uncategorized", selected: selection == nil) }
            ForEach(CategoryGrouping.group(model.categories, matching: query), id: \.name) { group in
                Section(group.name) {
                    ForEach(group.items) { category in
                        Button { choose(category.id) } label: { row(category.name, selected: selection == category.id) }
                    }
                }
            }
        }
        .themedForm()
        .navigationTitle("Category")
        .searchable(text: $query)
    }

    private func choose(_ id: String?) {
        selection = id
        dismiss()
    }

    private func row(_ title: String, selected: Bool) -> some View {
        HStack {
            Text(title).textStyle(.body)
            Spacer()
            if selected { Image(systemName: "checkmark").foregroundStyle(Palette.accent) }
        }
        .contentShape(Rectangle())
    }
}
