import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public protocol TokenProvider: Sendable {
  func token() async throws -> String?
  func refreshToken(afterUnauthorizedToken token: String?) async throws -> String?
}

extension TokenProvider {
  public func refreshToken(afterUnauthorizedToken token: String?) async throws -> String? {
    try await self.token()
  }
}

public struct AsyncTokenProvider: TokenProvider, Sendable {
  private let operation: @Sendable () async throws -> String?

  public init(_ operation: @escaping @Sendable () async throws -> String?) {
    self.operation = operation
  }

  public func token() async throws -> String? {
    try await operation()
  }
}

public enum HTTPMethod: String, Sendable {
  case get = "GET"
}

public struct TransportRequest: Sendable, Equatable {
  public let method: HTTPMethod
  public let path: String
  public let query: [URLQueryItem]

  public init(method: HTTPMethod = .get, path: String, query: [URLQueryItem] = []) {
    self.method = method
    self.path = path
    self.query = query
  }
}

public struct TransportResponse: Sendable, Equatable {
  public let statusCode: Int
  public let data: Data

  public init(statusCode: Int, data: Data) {
    self.statusCode = statusCode
    self.data = data
  }
}

public protocol KortixTransporting: Sendable {
  func send(_ request: TransportRequest) async throws -> TransportResponse
}

public enum KortixTransportError: Error, Sendable, Equatable {
  case invalidBaseURL
  case invalidPath(String)
  case invalidResponse
  case unauthorized
  case httpStatus(code: Int, body: Data)
  case network(String)
}

public struct URLSessionTransport: KortixTransporting, Sendable {
  private let baseURL: URL
  private let session: URLSession
  private let tokenProvider: (any TokenProvider)?

  public init(
    baseURL: URL,
    session: URLSession = .shared,
    tokenProvider: (any TokenProvider)? = nil,
    allowInsecureHTTP: Bool = false
  ) throws {
    guard let scheme = baseURL.scheme?.lowercased(),
      let host = baseURL.host,
      baseURL.user == nil,
      baseURL.password == nil,
      baseURL.query == nil,
      baseURL.fragment == nil,
      scheme == "https" || (scheme == "http" && (allowInsecureHTTP || Self.isLoopback(host)))
    else {
      throw KortixTransportError.invalidBaseURL
    }
    self.baseURL = baseURL
    self.session = session
    self.tokenProvider = tokenProvider
  }

  public func send(_ request: TransportRequest) async throws -> TransportResponse {
    let url = try makeURL(path: request.path, query: request.query)
    let originalToken = try await tokenProvider?.token()
    let first = try await execute(request, url: url, token: originalToken)
    if first.statusCode == 401 {
      guard let tokenProvider else { throw KortixTransportError.unauthorized }
      let refreshedToken = try await tokenProvider.refreshToken(
        afterUnauthorizedToken: originalToken)
      guard refreshedToken != originalToken else { throw KortixTransportError.unauthorized }
      let retry = try await execute(request, url: url, token: refreshedToken)
      guard retry.statusCode != 401 else { throw KortixTransportError.unauthorized }
      return try validate(retry)
    }
    return try validate(first)
  }

  private func execute(_ request: TransportRequest, url: URL, token: String?) async throws
    -> TransportResponse
  {
    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = request.method.rawValue
    urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token, !token.isEmpty {
      urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    do {
      let (data, response) = try await session.data(for: urlRequest)
      guard let httpResponse = response as? HTTPURLResponse else {
        throw KortixTransportError.invalidResponse
      }
      return TransportResponse(statusCode: httpResponse.statusCode, data: data)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as URLError where error.code == .cancelled {
      throw CancellationError()
    } catch let error as KortixTransportError {
      throw error
    } catch {
      throw KortixTransportError.network(String(describing: error))
    }
  }

  private func validate(_ response: TransportResponse) throws -> TransportResponse {
    guard 200..<300 ~= response.statusCode else {
      throw KortixTransportError.httpStatus(code: response.statusCode, body: response.data)
    }
    return response
  }

  private static func isLoopback(_ host: String) -> Bool {
    let normalized = host.lowercased()
    if normalized == "localhost" || normalized == "::1" || normalized == "[::1]" { return true }
    let octets = normalized.split(separator: ".", omittingEmptySubsequences: false)
    return octets.count == 4 && octets.first == "127"
      && octets.allSatisfy { octet in
        guard let value = UInt8(octet) else { return false }
        return String(value) == octet
      }
  }

  private func makeURL(path: String, query: [URLQueryItem]) throws -> URL {
    guard path.hasPrefix("/"),
      !path.contains("?"), !path.contains("#"),
      path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({
        $0 != ".." && $0 != "."
      })
    else {
      throw KortixTransportError.invalidPath(path)
    }
    var url = baseURL
    for segment in path.split(separator: "/") {
      url.appendPathComponent(String(segment))
    }
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw KortixTransportError.invalidPath(path)
    }
    if !query.isEmpty { components.queryItems = query }
    guard let finalURL = components.url else { throw KortixTransportError.invalidPath(path) }
    return finalURL
  }
}
