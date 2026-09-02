import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import KortixTransport

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

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

@Suite(.serialized)
struct URLSessionTransportTests {
@Test func attachesTokenAndEncodesQuery() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    let session = URLSession(configuration: configuration)
    URLProtocolStub.handler = { request in
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
        #expect(request.url?.absoluteString == "https://example.com/v1/projects?account_id=a%26b")
        return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("[]".utf8))
    }
    let transport = try URLSessionTransport(
        baseURL: URL(string: "https://example.com/v1")!,
        session: session,
        tokenProvider: AsyncTokenProvider { "secret" }
    )
    let response = try await transport.send(TransportRequest(path: "/projects", query: [.init(name: "account_id", value: "a&b")]))
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
        (HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: nil)!, Data("slow down".utf8))
    }
    let transport = try URLSessionTransport(baseURL: URL(string: "https://example.com")!, session: URLSession(configuration: configuration))
    await #expect(throws: KortixTransportError.httpStatus(code: 429, body: Data("slow down".utf8))) {
        try await transport.send(TransportRequest(path: "/accounts"))
    }
}
}
