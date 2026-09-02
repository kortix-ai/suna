import Foundation
import KortixSDK
import KortixTransport

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#endif

private enum DemoError: Error, CustomStringConvertible {
  case missingToken

  var description: String { "KORTIX_TOKEN is required" }
}

@main
enum Demo {
  static func main() async {
    do {
      try await run()
    } catch {
      FileHandle.standardError.write(Data("kortix-swift-demo: \(error)\n".utf8))
      exit(EXIT_FAILURE)
    }
  }

  private static func run() async throws {
    guard let token = ProcessInfo.processInfo.environment["KORTIX_TOKEN"], !token.isEmpty else {
      throw DemoError.missingToken
    }
    let baseURL = URL(
      string: ProcessInfo.processInfo.environment["KORTIX_API_URL"] ?? "https://api.kortix.com/v1")!
    let transport = try URLSessionTransport(
      baseURL: baseURL, tokenProvider: AsyncTokenProvider { token })
    let accounts = try await KortixClient(transport: transport).listAccounts()
    for account in accounts { print("\(account.accountID)\t\(account.name)") }
  }
}
