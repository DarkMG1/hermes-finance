import Testing
@testable import HermesKit

@Test func callbackSchemeMatchesTheServerRedirect() {
    #expect(HermesKit.callbackScheme == "hermesfinance")
}
