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

  private struct RefreshFlight: Sendable {
    let id: UUID
    let generation: UInt64
    let task: Task<AccessToken, Error>
  }

  private final class RefreshWaiter: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<AccessToken, Error>?
    private var result: Result<AccessToken, Error>?

    func wait() async throws -> AccessToken {
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          lock.lock()
          if let result {
            lock.unlock()
            continuation.resume(with: result)
          } else {
            self.continuation = continuation
            lock.unlock()
          }
        }
      } onCancel: {
        resolve(.failure(CancellationError()))
      }
    }

    func resolve(_ result: Result<AccessToken, Error>) {
      lock.lock()
      guard self.result == nil else {
        lock.unlock()
        return
      }
      self.result = result
      let continuation = self.continuation
      self.continuation = nil
      lock.unlock()
      continuation?.resume(with: result)
    }
  }

  private var current: AccessToken?
  private var generation: UInt64 = 0
  private var refreshFlight: RefreshFlight?
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

  public func refreshToken(afterUnauthorizedToken token: String?) async throws -> String? {
    if current?.value != token {
      return current?.value
    }
    return try await forceRefresh().value
  }

  public func setToken(_ token: AccessToken?) {
    generation &+= 1
    current = token
    refreshFlight?.task.cancel()
    refreshFlight = nil
  }

  public func clear() {
    setToken(nil)
  }

  @discardableResult
  public func forceRefresh() async throws -> AccessToken {
    try await refreshToken()
  }

  private func refreshToken() async throws -> AccessToken {
    try Task.checkCancellation()
    let flight: RefreshFlight
    if let refreshFlight {
      flight = refreshFlight
    } else {
      let previous = current
      let operation = refreshOperation
      let task = Task { try await operation(previous) }
      flight = RefreshFlight(id: UUID(), generation: generation, task: task)
      refreshFlight = flight
    }

    do {
      let refreshed = try await wait(for: flight)
      guard generation == flight.generation else {
        guard let current else { throw AuthSessionError.noToken }
        return current
      }
      try Task.checkCancellation()
      guard refreshFlight?.id == flight.id else {
        return current ?? refreshed
      }
      current = refreshed
      refreshFlight = nil
      return refreshed
    } catch is CancellationError {
      if !Task.isCancelled, refreshFlight?.id == flight.id {
        refreshFlight = nil
      }
      throw CancellationError()
    } catch let error as AuthSessionError where error == .noToken {
      throw error
    } catch {
      if refreshFlight?.id == flight.id {
        refreshFlight = nil
      }
      throw AuthSessionError.refreshFailed(String(describing: error))
    }
  }

  private func wait(for flight: RefreshFlight) async throws -> AccessToken {
    let waiter = RefreshWaiter()
    Task {
      do {
        waiter.resolve(.success(try await flight.task.value))
      } catch {
        waiter.resolve(.failure(error))
      }
    }
    return try await waiter.wait()
  }
}
