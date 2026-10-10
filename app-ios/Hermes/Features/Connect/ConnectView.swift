import SwiftUI

struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var url = ""
    @State private var token = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Field(label: "Server address") {
                        TextField("Server address", text: $url, prompt: Text(verbatim: "https://hermes.example.com"))
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    Field(label: "API token", error: error) {
                        SecureField("Paste the token", text: $token)
                    }
                }
                Section {
                    HButton(title: "Connect", busy: busy) { Task { await connect() } }
                        .disabled(url.isEmpty || token.isEmpty)
                }
            }
            .themedForm()
            .navigationTitle("Connect to Hermes")
        }
        .onAppear { url = model.serverURL }
    }

    private func connect() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await model.connect(urlText: url, token: token)
        } catch {
            self.error = errorMessage(error)
        }
    }
}
