import HermesKit
import SwiftUI

/// Pick whose money a row or line is. `nil` means the owner's own ("Me").
struct PersonPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String?
    /// nil: someone must be chosen
    var noneTitle: String? = "Me"
    var title = "For"
    @State private var adding = false
    @State private var query = ""
    /// the people picked last on this iPhone, newest first
    @AppStorage("recentPeople") private var recent = ""

    var body: some View {
        let people = model.people.filter { !$0.archived || $0.id == selection }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let found = people.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
        let recents = recent.split(separator: ",").compactMap { id in people.first { $0.id == id } }
        List {
            if let noneTitle, query.isEmpty { Button { choose(nil) } label: { SelectionRow(title: noneTitle, selected: selection == nil) } }
            // a long list: the few used lately come first, and search finds the rest
            if query.isEmpty, !recents.isEmpty, people.count > Self.recentCount {
                Section("Recent") { ForEach(recents) { row($0) } }
            }
            Section(query.isEmpty && people.count > Self.recentCount ? "Everyone" : "") {
                ForEach(found) { row($0) }
                if found.isEmpty, !query.isEmpty { Text("No one by that name").textStyle(.subhead, color: Palette.secondaryText) }
                Button("New person…") { adding = true }
            }
        }
        .searchable(text: $query)
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

    private static let recentCount = 4

    private func row(_ person: Person) -> some View {
        Button { choose(person.id) } label: { SelectionRow(title: person.name, selected: selection == person.id) }
    }

    private func choose(_ id: String?) {
        if let id { recent = ([id] + recent.split(separator: ",").map(String.init).filter { $0 != id }).prefix(Self.recentCount).joined(separator: ",") }
        selection = id
        dismiss()
    }
}
