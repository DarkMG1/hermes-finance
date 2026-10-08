// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HermesKit",
    platforms: [.iOS("26.0"), .macOS("15.0")],
    products: [.library(name: "HermesKit", targets: ["HermesKit"])],
    targets: [
        .target(name: "HermesKit"),
        .testTarget(name: "HermesKitTests", dependencies: ["HermesKit"], resources: [.copy("Fixtures")]),
    ]
)
