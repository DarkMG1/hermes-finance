import HermesKit
import SwiftUI

enum LoadState<Value: Sendable> {
    case loading
    case loaded(Loaded<Value>)
    case failed(String)
}

func errorMessage(_ error: Error) -> String {
    (error as? ClientError)?.message ?? error.localizedDescription
}

struct LoadingContent<Value: Sendable, Content: View>: View {
    let state: LoadState<Value>
    let retry: () -> Void
    @ViewBuilder var content: (Loaded<Value>) -> Content

    var body: some View {
        switch state {
        case .loading:
            ProgressView().frame(maxWidth: .infinity).padding(Space.xl)
        case .failed(let message):
            VStack(alignment: .leading, spacing: Space.m) {
                InlineError(message: message)
                HButton(title: "Try again", kind: .secondary, action: retry)
            }
        case .loaded(let loaded):
            content(loaded)
        }
    }
}

struct LastUpdated<Value: Sendable>: View {
    let loaded: Loaded<Value>

    var body: some View {
        if loaded.fromCache {
            Label("Offline · Last updated \(loaded.savedAt.formatted(.relative(presentation: .named)))", systemImage: "wifi.slash")
                .textStyle(.caption, color: Palette.secondaryText)
        }
    }
}
