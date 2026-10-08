import SwiftUI

// Deliberately violates every token rule; scripts/check-ios-lint.sh asserts all four fire.
struct BadTokens: View {
    var body: some View {
        VStack(spacing: 6) {
            Text("x")
                .font(.system(size: 13))
                .foregroundStyle(Color(red: 1, green: 0, blue: 0))
                .padding(10)
        }
    }
}
