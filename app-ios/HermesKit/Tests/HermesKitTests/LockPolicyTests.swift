import Foundation
import Testing
@testable import HermesKit

@Test func lockPolicyLocksOnLaunchAndAfterTheGracePeriod() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    #expect(LockPolicy.shouldLock(enabled: true, backgroundedAt: nil, now: now))
    #expect(!LockPolicy.shouldLock(enabled: true, backgroundedAt: now.addingTimeInterval(-29), now: now))
    #expect(LockPolicy.shouldLock(enabled: true, backgroundedAt: now.addingTimeInterval(-30), now: now))
    #expect(LockPolicy.shouldLock(enabled: true, backgroundedAt: now.addingTimeInterval(-3600), now: now))
}

@Test func lockPolicyNeverLocksWhenTurnedOff() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    #expect(!LockPolicy.shouldLock(enabled: false, backgroundedAt: nil, now: now))
    #expect(!LockPolicy.shouldLock(enabled: false, backgroundedAt: now.addingTimeInterval(-3600), now: now))
}
