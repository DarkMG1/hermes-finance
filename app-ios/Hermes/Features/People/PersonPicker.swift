import HermesKit
import SwiftUI

/// Pick whose money a row or line is. `nil` means the owner's own ("Me").
struct PersonPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String?
    var noneTitle = "Me"
    @State private var adding = false

    var body: some View {
        List {
            Button { choose(nil) } label: { row(noneTitle, selected: selection == nil) }
            Section {
                ForEach(model.people.filter { !$0.archived || $0.id == selection }) { person in
                    Button { choose(person.id) } label: { row(person.name, selected: selection == person.id) }
                }
                Button("New person…") { adding = true }
            }
        }
        .themedForm()
        .navigationTitle("For")
        .sheet(isPresented: $adding) {
            // stays on this list after adding, with the new person ticked, so two sheets never dismiss at once
            PersonSheet(person: nil) { created in if let created { selection = created.id } }
        }
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
