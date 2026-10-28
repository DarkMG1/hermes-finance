import HermesKit
import SwiftUI

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
                Field(label: "Name", error: nameError) { TextField("Name", text: $name) }
                Field(label: "Price", error: priceError) { TextField("0.00", text: $priceText).keyboardType(.decimalPad) }
                Toggle("Discount", isOn: $discount)
            }
            Section {
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
            } header: { Text("Who had it") } footer: {
                if people.isEmpty { InlineError(message: "Pick at least one person.") }
            }
        }
        .onAppear {
            name = item.name
            priceText = item.amountCents == 0 ? "" : Money.format(abs(item.amountCents)).replacingOccurrences(of: "$", with: "")
            discount = item.amountCents < 0
            people = item.people
        }
    }

    /// Shown once a price is typed, so a new item doesn't open with an error.
    private var nameError: String? {
        name.trimmingCharacters(in: .whitespaces).isEmpty && !priceText.isEmpty ? "Enter a name" : nil
    }

    private var priceError: String? {
        guard !priceText.isEmpty else { return nil }
        guard let cents = Money.parse(priceText) else { return "Enter an amount like 1.25" }
        if cents == 0 { return "Price can't be zero" }
        return cents > DraftItem.maxCents ? "Must be 100,000.00 or less" : nil
    }

    private var draft: DraftItem? {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !people.isEmpty, let cents = Money.parse(priceText), cents > 0, cents <= DraftItem.maxCents else { return nil }
        // keep the checklist's order stable: me first, then the choices' order
        return DraftItem(id: item.id, name: trimmed, amountCents: discount ? -cents : cents, people: choices.filter(people.contains))
    }
}
