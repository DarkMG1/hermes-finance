import Foundation

/// Parsed once per history response, shared by chart marks and the scrubbed header.
public struct PreparedHistory: Sendable {
    public struct Point: Sendable, Identifiable {
        public let day: Date
        public let value: NetWorthPoint
        public var id: String { value.date }
    }

    public let points: [Point]
    public let floor: Double

    public init(points: [NetWorthPoint], timeZone: TimeZone = .current) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        self.points = points.compactMap { point in
            let parts = point.date.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3,
                  let day = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)) else { return nil }
            return Point(day: day, value: point)
        }
        floor = Double(points.map(\.netWorthCents).min() ?? 0) / 100
    }

    /// Binary search also handles missing days and daylight-saving changes; ties select the earlier day.
    public func point(at date: Date?) -> Point? {
        guard let date, !points.isEmpty else { return nil }
        var lower = 0
        var upper = points.count
        while lower < upper {
            let middle = (lower + upper) / 2
            if points[middle].day < date { lower = middle + 1 } else { upper = middle }
        }
        if lower == 0 { return points.first }
        if lower == points.count { return points.last }
        let before = points[lower - 1]
        let after = points[lower]
        return date.timeIntervalSince(before.day) <= after.day.timeIntervalSince(date) ? before : after
    }
}
