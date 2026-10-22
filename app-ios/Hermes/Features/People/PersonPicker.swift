import HermesKit
import SwiftUI

/// Pick whose money a row or line is. `nil` means the owner's own ("Me").
struct PersonPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String?
    var noneTitle = "Me"
    var title = "For"
    @State private var adding = false

    var body: some View {
        List {
            Button { choose(nil) } label: { SelectionRow(title: noneTitle, selected: selection == nil) }
            Section {
                ForEach(model.people.filter { !$0.archived || $0.id == selection }) { person in
                    Button { choose(person.id) } label: { SelectionRow(title: person.name, selected: selection == person.id) }
                }
                Button("New person…") { adding = true }
            }
        }
        .themedForm()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $adding) {
            // stays on this list after adding, with the new person ticked, so two sheets never dismiss at once
            PersonSheet(person: nil) { created in
                if let created { selection = created.id } else { await model.refreshReferenceData() }
            }
        }
    }

    private func choose(_ id: String?) {
        selection = id
        dismiss()
    }
}
