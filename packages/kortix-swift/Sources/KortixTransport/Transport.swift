import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol TokenProvider: Sendable {
    func token() async throws -> String?
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
        tokenProvider: (any TokenProvider)? = nil
    ) throws {
        guard let scheme = baseURL.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              baseURL.host != nil else {
            throw KortixTransportError.invalidBaseURL
        }
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    public func send(_ request: TransportRequest) async throws -> TransportResponse {
        let url = try makeURL(path: request.path, query: request.query)
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = try await tokenProvider?.token(), !token.isEmpty {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: urlRequest)
        } catch {
            throw KortixTransportError.network(String(describing: error))
        }
        guard let response = result.1 as? HTTPURLResponse else {
            throw KortixTransportError.invalidResponse
        }
        if response.statusCode == 401 { throw KortixTransportError.unauthorized }
        guard 200..<300 ~= response.statusCode else {
            throw KortixTransportError.httpStatus(code: response.statusCode, body: result.0)
        }
        return TransportResponse(statusCode: response.statusCode, data: result.0)
    }

    private func makeURL(path: String, query: [URLQueryItem]) throws -> URL {
        guard path.hasPrefix("/"),
              !path.contains("?"), !path.contains("#"),
              path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ $0 != ".." && $0 != "." }) else {
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
