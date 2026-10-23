/// A retry must send the original body even if a refreshed model proposes a different one.
public struct PendingWrite<Body: Sendable>: Sendable {
    public var guardState = WriteGuard()
    public private(set) var body: Body?

    public init() {}

    public mutating func prepare(_ proposed: Body) -> Body {
        if guardState.unresolved, let body { return body }
        body = proposed
        return proposed
    }
}

/// An older tap or a read that outlived its screen must not replace an editor's draft.
public struct OpenGeneration: Sendable {
    private var generation = 0

    public init() {}

    public mutating func next() -> Int { generation += 1; return generation }

    public func accepts(_ request: Int, presented: Bool) -> Bool { request == generation && !presented }
}

/// A cursor belongs only to the query whose page succeeded.
public struct PageCursor<Query: Equatable & Sendable>: Sendable {
    private var query: Query?
    private var cursor: String?

    public init() {}

    public func next(for requested: Query) -> String? { query == requested ? cursor : nil }

    public mutating func reset() { query = nil; cursor = nil }

    public mutating func didLoad(_ requested: Query, nextCursor: String?) { query = requested; cursor = nextCursor }
}

/// A successful reload must not erase the explanation for a failed write.
public struct RequestErrors: Sendable {
    public var read: String?
    public var write: String?
    public var message: String? { write ?? read }

    public init() {}
}
