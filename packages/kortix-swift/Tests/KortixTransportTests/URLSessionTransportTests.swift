import Foundation
import Testing

@testable import KortixTransport

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var handler:
    (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let handler = Self.handler else { return }
    do {
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

private actor RefreshingTokenProvider: TokenProvider {
  private var current: String?
  private(set) var rejected: [String?] = []
  private let refreshed: String?

  init(current: String?, refreshed: String?) {
    self.current = current
    self.refreshed = refreshed
  }

  func token() async throws -> String? { current }

  func refreshToken(afterUnauthorizedToken token: String?) async throws -> String? {
    rejected.append(token)
    current = refreshed
    return refreshed
  }
}

private final class RequestRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var authorizationValues: [String?] = []

  func record(_ request: URLRequest) -> Int {
    lock.lock()
    defer { lock.unlock() }
    authorizationValues.append(request.value(forHTTPHeaderField: "Authorization"))
    return authorizationValues.count
  }

  func values() -> [String?] {
    lock.lock()
    defer { lock.unlock() }
    return authorizationValues
  }
}

@Suite(.serialized)
struct URLSessionTransportTests {
  @Test func attachesTokenAndEncodesQuery() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    let session = URLSession(configuration: configuration)
    URLProtocolStub.handler = { request in
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
      #expect(request.url?.absoluteString == "https://example.com/v1/projects?account_id=a%26b")
      return (
        HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
        Data("[]".utf8)
      )
    }
    let transport = try URLSessionTransport(
      baseURL: URL(string: "https://example.com/v1")!,
      session: session,
      tokenProvider: AsyncTokenProvider { "secret" }
    )
    let response = try await transport.send(
      TransportRequest(path: "/projects", query: [.init(name: "account_id", value: "a&b")]))
    #expect(response.statusCode == 200)
  }

  @Test func rejectsPathTraversal() async throws {
    let transport = try URLSessionTransport(baseURL: URL(string: "https://example.com/v1")!)
    await #expect(throws: KortixTransportError.invalidPath("/../admin")) {
      try await transport.send(TransportRequest(path: "/../admin"))
    }
  }

  @Test func mapsNonSuccessResponseToTypedError() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    URLProtocolStub.handler = { request in
      (
        HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: nil)!,
        Data("slow down".utf8)
      )
    }
    let transport = try URLSessionTransport(
      baseURL: URL(string: "https://example.com")!,
      session: URLSession(configuration: configuration))
    await #expect(throws: KortixTransportError.httpStatus(code: 429, body: Data("slow down".utf8)))
    {
      try await transport.send(TransportRequest(path: "/accounts"))
    }
  }

  @Test func retriesOnceAfter401OnlyWhenRefreshChangesToken() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    let recorder = RequestRecorder()
    URLProtocolStub.handler = { request in
      let attempt = recorder.record(request)
      let status = attempt == 1 ? 401 : 200
      return (
        HTTPURLResponse(
          url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
        Data("ok".utf8)
      )
    }
    let provider = RefreshingTokenProvider(current: "old", refreshed: "new")
    let transport = try URLSessionTransport(
      baseURL: URL(string: "https://example.com")!,
      session: URLSession(configuration: configuration),
      tokenProvider: provider
    )

    #expect(try await transport.send(TransportRequest(path: "/accounts")).statusCode == 200)
    #expect(recorder.values() == ["Bearer old", "Bearer new"])
    #expect(await provider.rejected == ["old"])
  }

  @Test func doesNotRetry401WhenRefreshReturnsSameToken() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    let recorder = RequestRecorder()
    URLProtocolStub.handler = { request in
      _ = recorder.record(request)
      return (
        HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!,
        Data()
      )
    }
    let provider = RefreshingTokenProvider(current: "same", refreshed: "same")
    let transport = try URLSessionTransport(
      baseURL: URL(string: "https://example.com")!,
      session: URLSession(configuration: configuration),
      tokenProvider: provider
    )

    await #expect(throws: KortixTransportError.unauthorized) {
      try await transport.send(TransportRequest(path: "/accounts"))
    }
    #expect(recorder.values().count == 1)
    #expect(await provider.rejected == ["same"])
  }

  @Test func retryStopsAfterSecond401() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    let recorder = RequestRecorder()
    URLProtocolStub.handler = { request in
      _ = recorder.record(request)
      return (
        HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!,
        Data()
      )
    }
    let provider = RefreshingTokenProvider(current: "old", refreshed: "new")
    let transport = try URLSessionTransport(
      baseURL: URL(string: "https://example.com")!,
      session: URLSession(configuration: configuration),
      tokenProvider: provider
    )

    await #expect(throws: KortixTransportError.unauthorized) {
      try await transport.send(TransportRequest(path: "/accounts"))
    }
    #expect(recorder.values().count == 2)
    #expect(await provider.rejected == ["old"])
  }

  @Test func validatesSecureBaseURLs() throws {
    for value in [
      "http://example.com/v1",
      "https://user@example.com/v1",
      "https://example.com/v1?tenant=a",
      "https://example.com/v1#fragment",
    ] {
      #expect(throws: KortixTransportError.invalidBaseURL) {
        try URLSessionTransport(baseURL: URL(string: value)!)
      }
    }

    _ = try URLSessionTransport(baseURL: URL(string: "http://localhost:8008/v1")!)
    _ = try URLSessionTransport(baseURL: URL(string: "http://127.0.0.1:8008/v1")!)
    _ = try URLSessionTransport(baseURL: URL(string: "http://[::1]:8008/v1")!)
    _ = try URLSessionTransport(
      baseURL: URL(string: "http://dev.internal/v1")!,
      allowInsecureHTTP: true
    )
  }

  @Test func preservesNetworkCancellationAsCancellationError() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    URLProtocolStub.handler = { _ in throw URLError(.cancelled) }
    let transport = try URLSessionTransport(
      baseURL: URL(string: "https://example.com")!,
      session: URLSession(configuration: configuration)
    )

    await #expect(throws: CancellationError.self) {
      try await transport.send(TransportRequest(path: "/accounts"))
    }
  }

}
