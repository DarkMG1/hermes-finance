import SwiftUI

struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @State private var url = ""
    @State private var token = ""
    @State private var error: String?
    @State private var busy = false
    @AppStorage("faceIDChanged") private var faceIDChanged = false

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
                } footer: {
                    if faceIDChanged {
                        Text("Face ID changed on this iPhone. Check Settings › Face ID & Passcode for an appearance you didn't add, "
                             + "then enter the server token to continue.")
                    }
                }
                Section {
                    HButton(title: "Connect", busy: busy) { Task { await connect() } }
                        .disabled(url.isEmpty || token.isEmpty)
                }
            }
            .themedForm()
            .navigationTitle("Connect to Hermes")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear { url = model.serverURL }
    }

    private func connect() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            lock.connectStarting()
            try await model.connect(urlText: url, token: token)
            faceIDChanged = false
        } catch {
            lock.connectFailed()
            self.error = errorMessage(error)
        }
    }
}
