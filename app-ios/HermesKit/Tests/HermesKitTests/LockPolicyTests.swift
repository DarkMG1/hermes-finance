import Foundation
import Testing
@testable import HermesKit

@Test func lockPolicyLocksOnLaunchAndAfterTheGracePeriod() {
    #expect(LockPolicy.shouldLock(enabled: true, awayFor: nil))
    #expect(!LockPolicy.shouldLock(enabled: true, awayFor: 29))
    #expect(LockPolicy.shouldLock(enabled: true, awayFor: 30))
    #expect(LockPolicy.shouldLock(enabled: true, awayFor: 3600))
}

@Test func lockPolicyNeverLocksWhenTurnedOff() {
    #expect(!LockPolicy.shouldLock(enabled: false, awayFor: nil))
    #expect(!LockPolicy.shouldLock(enabled: false, awayFor: 3600))
}
