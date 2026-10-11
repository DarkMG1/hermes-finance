import Foundation

@MainActor
enum DayText {
    // built on every call, so a time-zone change while the app runs can't shift a day
    private static var gregorian: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    static func ymd(_ date: Date) -> String {
        let day = gregorian.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", day.year ?? 0, day.month ?? 0, day.day ?? 0)
    }

    /// Noon on that day: midnight doesn't exist on some daylight-saving days.
    static func date(_ ymd: String) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return gregorian.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    static func display(_ ymd: String) -> String {
        guard let date = date(ymd) else { return ymd }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let sameYear = calendar.isDate(date, equalTo: .now, toGranularity: .year)
        return date.formatted(.dateTime.month(.abbreviated).day().year(sameYear ? .omitted : .defaultDigits))
    }
}
