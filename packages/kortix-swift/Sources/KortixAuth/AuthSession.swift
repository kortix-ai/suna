import Foundation
import KortixTransport

public struct AccessToken: Sendable, Equatable {
    public let value: String
    public let expiresAt: Date

    public init(value: String, expiresAt: Date) {
        self.value = value
        self.expiresAt = expiresAt
    }
}

public enum AuthSessionError: Error, Sendable, Equatable {
    case noToken
    case refreshFailed(String)
}

public actor AuthSession: TokenProvider {
    public typealias RefreshOperation = @Sendable (AccessToken?) async throws -> AccessToken

    private var current: AccessToken?
    private var refreshTask: Task<AccessToken, Error>?
    private let refreshLeeway: TimeInterval
    private let now: @Sendable () -> Date
    private let refreshOperation: RefreshOperation

    public init(
        token: AccessToken? = nil,
        refreshLeeway: TimeInterval = 60,
        now: @escaping @Sendable () -> Date = Date.init,
        refresh: @escaping RefreshOperation
    ) {
        self.current = token
        self.refreshLeeway = refreshLeeway
        self.now = now
        self.refreshOperation = refresh
    }

    public func token() async throws -> String? {
        if let current, current.expiresAt.timeIntervalSince(now()) > refreshLeeway {
            return current.value
        }
        return try await refreshToken().value
    }

    public func setToken(_ token: AccessToken?) {
        current = token
        refreshTask?.cancel()
        refreshTask = nil
    }

    public func clear() {
        setToken(nil)
    }

    @discardableResult
    public func forceRefresh() async throws -> AccessToken {
        current = nil
        return try await refreshToken()
    }

    private func refreshToken() async throws -> AccessToken {
        if let refreshTask { return try await refreshTask.value }
        let previous = current
        let operation = refreshOperation
        let task = Task { try await operation(previous) }
        refreshTask = task
        do {
            let refreshed = try await task.value
            current = refreshed
            refreshTask = nil
            return refreshed
        } catch {
            refreshTask = nil
            throw AuthSessionError.refreshFailed(String(describing: error))
        }
    }
}
