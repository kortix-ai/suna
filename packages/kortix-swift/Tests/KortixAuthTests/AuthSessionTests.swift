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
