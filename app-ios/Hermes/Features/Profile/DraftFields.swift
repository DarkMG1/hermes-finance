import HermesKit
import SwiftUI

/// One input on a review form, read from and written into its body by key path. `key` is the body's JSON name, as `uncertain` lists it.
struct DraftField<B> {
    enum Kind {
        case money(WritableKeyPath<B, Int?>, signed: Bool = false)
        case whole(WritableKeyPath<B, Int?>)
        case number(WritableKeyPath<B, Double?>)
        case date(WritableKeyPath<B, String?>)
        case text(WritableKeyPath<B, String?>)
        /// "federal" or a state code
        case code(WritableKeyPath<B, String?>)
        case choice(WritableKeyPath<B, String?>, [(value: String, label: String)])
        case flag(WritableKeyPath<B, Bool?>)
    }

    let key: String
    let label: String
    let kind: Kind
    /// a choice the server needs: no "None"
    var required = false

    func text(_ body: B) -> String {
        switch kind {
        case .money(let p, _): FieldText.cents(body[keyPath: p])
        case .whole(let p): body[keyPath: p].map(String.init) ?? ""
        case .number(let p): FieldText.number(body[keyPath: p])
        case .date(let p), .text(let p), .code(let p), .choice(let p, _): body[keyPath: p] ?? ""
        case .flag(let p): body[keyPath: p].map { $0 ? "yes" : "no" } ?? ""
        }
    }

    /// Writes what the text means into `body` (empty is nil); false when it doesn't parse.
    func apply(_ text: String, to body: inout B) -> Bool {
        func put<T>(_ p: WritableKeyPath<B, T?>, _ parse: (String) -> T?) -> Bool {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            // a required choice left blank keeps Save off
            guard !t.isEmpty else { body[keyPath: p] = nil; return !required }
            guard let v = parse(t) else { return false }
            body[keyPath: p] = v
            return true
        }
        switch kind {
        case .money(let p, let signed): return put(p) { FieldText.cents($0, signed: signed) }
        case .whole(let p): return put(p, FieldText.whole)
        case .number(let p): return put(p, FieldText.number)
        case .date(let p): return put(p, FieldText.date)
        case .text(let p), .choice(let p, _): return put(p) { $0 }
        case .code(let p): return put(p, FieldText.code)
        case .flag(let p): return put(p) { $0 == "yes" }
        }
    }

    /// Empty text counts: the server says which fields it needs.
    func parses(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return true }
        return switch kind {
        case .money(_, let signed): FieldText.cents(t, signed: signed) != nil
        case .whole: FieldText.whole(t) != nil
        case .number: FieldText.number(t) != nil
        case .date: FieldText.date(t) != nil
        case .text, .code, .choice, .flag: true
        }
    }

    var hint: String {
        switch kind {
        case .money: "Enter an amount like 1,234.56"
        case .whole: "Enter a whole number"
        case .number: "Enter a number"
        case .date: "Enter a date like 2026-01-31"
        case .text, .code, .choice, .flag: ""
        }
    }

    var options: [(value: String, label: String)]? {
        switch kind {
        case .choice(_, let options): options
        case .flag: [("yes", "Yes"), ("no", "No")]
        default: nil
        }
    }

    static func texts(_ fields: [DraftField], _ body: B) -> [String: String] {
        Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0.text(body)) })
    }

    /// `base` with every field's text, or nil when one doesn't parse.
    static func build(_ fields: [DraftField], _ texts: [String: String], _ base: B) -> B? {
        var body = base
        return fields.allSatisfy { $0.apply(texts[$0.key] ?? "", to: &body) } ? body : nil
    }
}

struct DraftFields<B>: View {
    let fields: [DraftField<B>]
    @Binding var texts: [String: String]
    let uncertain: Set<String>

    var body: some View {
        ForEach(fields, id: \.key) { field in
            let text = Binding { texts[field.key] ?? "" } set: { texts[field.key] = $0 }
            Group {
                if let options = field.options {
                    Picker(field.label, selection: text) {
                        if !field.required || text.wrappedValue.isEmpty { Text(field.required ? "Choose" : "None").tag("") }
                        ForEach(options, id: \.value) { Text($0.label).tag($0.value) }
                    }
                } else if field.key == "note" {
                    NotesField(text: text, label: field.label)
                } else {
                    Field(label: field.label, error: field.parses(text.wrappedValue) ? nil : field.hint) {
                        TextField(field.label, text: text)
                            .keyboardType(Self.keyboard(field.kind))
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(Self.isCode(field.kind) ? .characters : .sentences)
                    }
                }
            }
            // what Claude wasn't sure of stands out until checked
            .listRowBackground(uncertain.contains(field.key) ? Palette.loss.opacity(0.15) : nil)
            .accessibilityHint(uncertain.contains(field.key) ? "Not sure this was read right; check it against the document" : "")
        }
    }

    private static func isCode(_ kind: DraftField<B>.Kind) -> Bool { if case .code = kind { true } else { false } }

    private static func keyboard(_ kind: DraftField<B>.Kind) -> UIKeyboardType {
        switch kind {
        case .money(_, let signed): signed ? .numbersAndPunctuation : .decimalPad
        case .whole: .numberPad
        case .number: .decimalPad
        case .date: .numbersAndPunctuation
        case .text, .code, .choice, .flag: .default
        }
    }
}
