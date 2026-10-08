import Foundation

@MainActor
enum DayText {
    private static let ymdFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func ymd(_ date: Date) -> String { ymdFormatter.string(from: date) }

    static func display(_ ymd: String) -> String {
        guard let date = ymdFormatter.date(from: ymd) else { return ymd }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let sameYear = calendar.isDate(date, equalTo: .now, toGranularity: .year)
        return date.formatted(.dateTime.month(.abbreviated).day().year(sameYear ? .omitted : .defaultDigits))
    }
}
