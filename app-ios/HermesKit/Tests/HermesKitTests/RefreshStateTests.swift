import Foundation
import Testing
@testable import HermesKit

@Test func onlyNewestRefreshCanInstallDataOrErrors() {
    var generation = OpenGeneration()
    let beforeEdit = generation.next()
    let afterEdit = generation.next()
    #expect(generation.accepts(afterEdit, presented: false))
    #expect(!generation.accepts(beforeEdit, presented: false))
}

@Test func successfulReloadDoesNotEraseARepaymentFailure() {
    var errors = RequestErrors()
    errors.write = "Couldn't confirm. Try again."
    errors.read = "Offline"
    errors.read = nil
    #expect(errors.message == "Couldn't confirm. Try again.")
    errors.write = nil // next action starts
    #expect(errors.message == nil)
    errors.read = "Offline"
    #expect(errors.message == "Offline")
}

@Test func reconcileReadDuringPendingCheckCannotRestoreCheckedRow() throws {
    let list = try JSONDecoder().decode(ReconcileList.self, from: fixture("reconcile"))
    let checked = try #require(list.transactions.first)
    let rows = list.excludingPendingChecks([checked.id])
    #expect(!rows.contains { $0.id == checked.id })
    #expect(rows.count == list.transactions.count - 1)
    // A refused check can show the current server row again.
    #expect(list.excludingPendingChecks([]).contains { $0.id == checked.id })
}
