import Foundation
import Testing

@testable import KortixAuth

private actor Counter {
  var value = 0
  func increment() { value += 1 }
}

@Test func returnsUnexpiredTokenWithoutRefresh() async throws {
  let session = AuthSession(
    token: AccessToken(value: "valid", expiresAt: Date(timeIntervalSince1970: 200)),
    refreshLeeway: 10,
    now: { Date(timeIntervalSince1970: 100) },
    refresh: { _ in throw AuthSessionError.noToken }
  )
  #expect(try await session.token() == "valid")
}

@Test func coalescesConcurrentRefreshes() async throws {
  let counter = Counter()
  let session = AuthSession(
    now: { Date(timeIntervalSince1970: 100) },
    refresh: { _ in
      await counter.increment()
      try await Task.sleep(for: .milliseconds(10))
      return AccessToken(value: "refreshed", expiresAt: Date(timeIntervalSince1970: 1000))
    }
  )
  async let first = session.token()
  async let second = session.token()
  #expect(try await [first, second] == ["refreshed", "refreshed"])
  #expect(await counter.value == 1)
}

private actor RefreshProbe {
  private var observed: [AccessToken?] = []
  private var continuations: [CheckedContinuation<AccessToken, Never>] = []

  func refresh(_ previous: AccessToken?) async -> AccessToken {
    observed.append(previous)
    return await withCheckedContinuation { continuations.append($0) }
  }

  func waitUntilStarted() async {
    while continuations.isEmpty { await Task.yield() }
  }

  func finish(with token: AccessToken) {
    let pending = continuations
    continuations.removeAll()
    for continuation in pending { continuation.resume(returning: token) }
  }

  func previousTokens() -> [AccessToken?] { observed }
}

@Test func setTokenCannotBeUndoneByStaleRefresh() async throws {
  let probe = RefreshProbe()
  let session = AuthSession(refresh: { previous in await probe.refresh(previous) })
  let waiting = Task { try await session.token() }
  await probe.waitUntilStarted()

  let replacement = AccessToken(value: "replacement", expiresAt: .distantFuture)
  await session.setToken(replacement)
  await probe.finish(with: AccessToken(value: "stale", expiresAt: .distantFuture))

  #expect(try await waiting.value == "replacement")
  #expect(try await session.token() == "replacement")
}

@Test func clearCannotBeUndoneByStaleRefresh() async throws {
  let probe = RefreshProbe()
  let session = AuthSession(refresh: { previous in await probe.refresh(previous) })
  let waiting = Task { try await session.token() }
  await probe.waitUntilStarted()

  await session.clear()
  await probe.finish(with: AccessToken(value: "stale", expiresAt: .distantFuture))

  await #expect(throws: AuthSessionError.noToken) { try await waiting.value }
}

@Test func forceRefreshPassesPreviousToken() async throws {
  let old = AccessToken(value: "old", expiresAt: .distantFuture)
  let probe = RefreshProbe()
  let session = AuthSession(token: old, refresh: { previous in await probe.refresh(previous) })
  let waiting = Task { try await session.forceRefresh() }
  await probe.waitUntilStarted()
  await probe.finish(with: AccessToken(value: "new", expiresAt: .distantFuture))

  #expect(try await waiting.value.value == "new")
  #expect(await probe.previousTokens() == [old])
}

@Test func refreshCancellationRemainsCancellationError() async {
  let session = AuthSession(refresh: { _ in throw CancellationError() })
  await #expect(throws: CancellationError.self) { try await session.token() }
}

@Test func unauthorizedOldTokenUsesAlreadyChangedTokenWithoutRefresh() async throws {
  let counter = Counter()
  let replacement = AccessToken(value: "replacement", expiresAt: .distantFuture)
  let session = AuthSession(
    token: replacement,
    refresh: { _ in
      await counter.increment()
      return AccessToken(value: "unexpected", expiresAt: .distantFuture)
    })

  #expect(try await session.refreshToken(afterUnauthorizedToken: "old") == "replacement")
  #expect(await counter.value == 0)
}

private actor CompletionFlag {
  private var completed = false

  func markCompleted() { completed = true }
  func isCompleted() -> Bool { completed }
}

@Test func canceledWaiterExitsBeforeSharedRefreshCompletes() async throws {
  let probe = RefreshProbe()
  let completion = CompletionFlag()
  let session = AuthSession(refresh: { previous in await probe.refresh(previous) })
  let canceled = Task { try await session.token() }
  let successful = Task { try await session.token() }
  await probe.waitUntilStarted()

  canceled.cancel()
  let cancellationObserver = Task {
    await #expect(throws: CancellationError.self) { try await canceled.value }
    await completion.markCompleted()
  }

  for _ in 0..<1_000 where !(await completion.isCompleted()) {
    await Task.yield()
  }
  let completedBeforeRefresh = await completion.isCompleted()

  await probe.finish(with: AccessToken(value: "shared", expiresAt: .distantFuture))
  await cancellationObserver.value

  #expect(completedBeforeRefresh)
  #expect(try await successful.value == "shared")
  #expect(await probe.previousTokens().count == 1)
}
