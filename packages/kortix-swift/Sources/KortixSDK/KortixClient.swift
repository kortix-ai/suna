import Foundation
@_exported import KortixAuth
import KortixTransport

public enum KortixSDKError: Error, Sendable, Equatable {
  case decoding(String)
}

public struct KortixClient: Sendable {
  private let transport: any KortixTransporting
  private let decoder: JSONDecoder

  public init(transport: any KortixTransporting) {
    self.transport = transport
    self.decoder = JSONDecoder()
  }

  public func listAccounts() async throws -> [Account] {
    try await get(path: "/accounts")
  }

  public func getAccount(_ accountID: String) async throws -> AccountDetail {
    try await get(path: "/accounts/\(try pathSegment(accountID))")
  }

  public func listProjects(accountID: String? = nil) async throws -> [Project] {
    let query = accountID.map { [URLQueryItem(name: "account_id", value: $0)] } ?? []
    return try await get(path: "/projects", query: query)
  }

  public func getProject(_ projectID: String) async throws -> Project {
    try await get(path: "/projects/\(try pathSegment(projectID))")
  }

  private func get<Value: Decodable>(path: String, query: [URLQueryItem] = []) async throws -> Value
  {
    let response = try await transport.send(TransportRequest(path: path, query: query))
    do { return try decoder.decode(Value.self, from: response.data) } catch {
      throw KortixSDKError.decoding(String(describing: error))
    }
  }

  private func pathSegment(_ value: String) throws -> String {
    guard !value.isEmpty, !value.contains("/"), value != ".", value != ".." else {
      throw KortixTransportError.invalidPath(value)
    }
    return value
  }
}
