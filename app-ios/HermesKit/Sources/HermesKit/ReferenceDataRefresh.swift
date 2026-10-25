import Foundation

/// Launch callers share a read; an explicit refresh after an edit always supersedes it.
@MainActor
public final class ReferenceDataRefresh {
    public struct Value: Sendable {
        public let categories: [Category]?
        public let accounts: [Account]?
        public let people: [Person]?
        fileprivate let generation: Int
    }

    private var task: Task<Value?, Never>?
    private var generation = OpenGeneration()

    public init() {}

    public func isCurrent(_ value: Value) -> Bool { generation.accepts(value.generation, presented: false) }

    public func invalidate() {
        _ = generation.next()
        task?.cancel()
        task = nil
    }

    public func request(using reader: Reader, coalescing: Bool) -> Task<Value?, Never> {
        if coalescing, let task { return task }
        invalidate()
        let gen = generation.next()
        let task = Task<Value?, Never> { @MainActor in
            async let categories = try? reader.read("/v1/categories", as: [Category].self)
            async let accounts = try? reader.read("/v1/accounts", as: [Account].self)
            async let people = try? reader.read("/v1/people", query: [URLQueryItem(name: "all", value: "1")], as: [Person].self)
            let value = await Value(categories: categories?.value, accounts: accounts?.value, people: people?.value, generation: gen)
            guard generation.accepts(gen, presented: false), !Task.isCancelled else { return nil }
            self.task = nil
            return value
        }
        self.task = task
        return task
    }
}
