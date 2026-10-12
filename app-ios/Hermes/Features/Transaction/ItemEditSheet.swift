import HermesKit
import SwiftUI

/// One receipt item being edited on the Itemize screen.
struct DraftItem: Identifiable, Equatable {
    let id: String
    var name: String
    var amountCents: Int
    var people: [String]
}

/// Name, price and who had it. A discount is entered as a positive amount with Discount on.
struct ItemEditSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: DraftItem
    /// "me" first, then person ids.
    let choices: [String]
    let onDone: (DraftItem) -> Void

    @State private var name = ""
    @State private var priceText = ""
    @State private var discount = false
    @State private var people: [String] = []

    var body: some View {
        Sheet(title: "Item", saveTitle: "Done", canSave: draft != nil, onCancel: { dismiss() }, onSave: {
            if let draft { onDone(draft) }
            dismiss()
        }) { // swiftlint:disable:this multiple_closures_with_trailing_closure
            Section {
                Field(label: "Name") { TextField("Name", text: $name) }
                Field(label: "Price") { TextField("0.00", text: $priceText).keyboardType(.decimalPad) }
                Toggle("Discount", isOn: $discount)
            }
            Section("Who had it") {
                ForEach(choices, id: \.self) { person in
                    Button {
                        if let i = people.firstIndex(of: person) { people.remove(at: i) } else { people.append(person) }
                    } label: {
                        HStack {
                            Text(person == ItemShares.me ? "Me" : model.personName(person)).foregroundStyle(Palette.text)
                            Spacer()
                            if people.contains(person) { Image(systemName: "checkmark").foregroundStyle(Palette.accent) }
                        }
                    }
                    .accessibilityAddTraits(people.contains(person) ? .isSelected : [])
                }
            }
        }
        .onAppear {
            name = item.name
            priceText = item.amountCents == 0 ? "" : Money.format(abs(item.amountCents)).replacingOccurrences(of: "$", with: "")
            discount = item.amountCents < 0
            people = item.people
        }
    }

    private var draft: DraftItem? {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !people.isEmpty, let cents = Money.parse(priceText), cents > 0 else { return nil }
        // keep the checklist's order stable: me first, then the choices' order
        return DraftItem(id: item.id, name: trimmed, amountCents: discount ? -cents : cents, people: choices.filter(people.contains))
    }
}
