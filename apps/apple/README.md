# Kortix Apple shell

The first native slice is the independent Swift package at `packages/kortix-swift`.
It supports macOS 13+, iOS 16+, and Swift 6 strict concurrency.

```sh
cd packages/kortix-swift
swift test
KORTIX_TOKEN=<token> swift run kortix-swift-demo
```

Set `KORTIX_API_URL` to override `https://api.kortix.com/v1`. The demo only lists accounts. It does not require an Xcode project.
