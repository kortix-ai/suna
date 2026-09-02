import Foundation
import KortixSDK
import KortixTransport

@main
enum Demo {
    static func main() async throws {
        guard let token = ProcessInfo.processInfo.environment["KORTIX_TOKEN"], !token.isEmpty else {
            FileHandle.standardError.write(Data("Set KORTIX_TOKEN to list accounts.\n".utf8))
            return
        }
        let baseURL = URL(string: ProcessInfo.processInfo.environment["KORTIX_API_URL"] ?? "https://api.kortix.com/v1")!
        let transport = try URLSessionTransport(baseURL: baseURL, tokenProvider: AsyncTokenProvider { token })
        let accounts = try await KortixClient(transport: transport).listAccounts()
        for account in accounts { print("\(account.accountID)\t\(account.name)") }
    }
}
