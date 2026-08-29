// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MacCIBurst",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "MacCIBurst", targets: ["MacCIBurst"])],
    targets: [.executableTarget(name: "MacCIBurst")]
)
