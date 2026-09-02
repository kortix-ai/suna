// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KortixSwift",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "KortixTransport", targets: ["KortixTransport"]),
        .library(name: "KortixAuth", targets: ["KortixAuth"]),
        .library(name: "KortixSDK", targets: ["KortixSDK"]),
        .executable(name: "kortix-swift-demo", targets: ["KortixDemo"]),
    ],
    dependencies: [.package(url: "https://github.com/swiftlang/swift-testing.git", exact: "0.12.0")],
    targets: [
        .target(name: "KortixTransport"),
        .target(name: "KortixAuth", dependencies: ["KortixTransport"]),
        .target(name: "KortixSDK", dependencies: ["KortixTransport", "KortixAuth"]),
        .executableTarget(name: "KortixDemo", dependencies: ["KortixSDK", "KortixTransport"]),
        .testTarget(name: "KortixTransportTests", dependencies: ["KortixTransport", .product(name: "Testing", package: "swift-testing")]),
        .testTarget(name: "KortixAuthTests", dependencies: ["KortixAuth", .product(name: "Testing", package: "swift-testing")]),
        .testTarget(name: "KortixSDKTests", dependencies: ["KortixSDK", "KortixTransport", .product(name: "Testing", package: "swift-testing")]),
    ]
)
