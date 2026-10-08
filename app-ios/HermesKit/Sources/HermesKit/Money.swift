import Foundation

public enum Money {
    /// USD, grouped thousands, typographic minus for money out.
    public static func format(_ cents: Int, showPlus: Bool = false) -> String {
        let magnitude = cents.magnitude
        var whole = String(magnitude / 100)
        var grouped = ""
        while whole.count > 3 {
            grouped = "," + whole.suffix(3) + grouped
            whole.removeLast(3)
        }
        let remainder = magnitude % 100
        let text = "$" + whole + grouped + "." + (remainder < 10 ? "0" : "") + String(remainder)
        if cents < 0 { return "\u{2212}" + text }
        return showPlus && cents > 0 ? "+" + text : text
    }

    /// Exact cents from user input; the sign comes from the form, not the text.
    public static func parse(_ text: String) -> Int? {
        var s = text.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("$") { s.removeFirst() }
        guard s.range(of: #"^(\d{1,3}(,\d{3}){1,2}|\d{0,9})(\.\d{0,2})?$"#, options: .regularExpression) != nil,
              s.contains(where: \.isNumber) else { return nil }
        let parts = s.replacingOccurrences(of: ",", with: "").split(separator: ".", omittingEmptySubsequences: false)
        let whole = parts.first.map { $0.isEmpty ? 0 : Int($0) ?? 0 } ?? 0
        let fraction = parts.count > 1 ? Int(String(parts[1]).padding(toLength: 2, withPad: "0", startingAt: 0)) ?? 0 : 0
        return whole * 100 + fraction
    }
}
