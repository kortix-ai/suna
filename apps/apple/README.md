# Kortix Apple shell

The first native slice is the independent `KortixSwift` package at
`packages/kortix-swift`. It targets macOS 13+, iOS 16+, and Swift 6.

The package currently exports these products:

- `KortixTransport`
- `KortixAuth`
- `KortixSDK`
- `kortix-swift-demo`, implemented by `KortixDemo`

It does not yet export `KortixCore`, `KortixSession`, or a UI module.

```sh
cd packages/kortix-swift
swift test
KORTIX_TOKEN='your-token' swift run kortix-swift-demo
```

Set `KORTIX_API_URL` to override `https://api.kortix.com/v1`. The demo lists
accounts through the real API. It does not require an Xcode project.

The repository contains no native iOS or macOS application in this directory.
It does not yet prove TestFlight, App Store, signing, notarization, or macOS
update distribution. ADR-007 requires those gates before external distribution.
