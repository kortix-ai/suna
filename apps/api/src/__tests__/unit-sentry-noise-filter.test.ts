/**
 * Regression test for the Sentry noise filter (ignoreErrors).
 *
 * Better Stack pattern c672fb5e8c4f366e2aecab35a4abf23c8bb3fa26f0eb1d8cafddf3cd3ca26e55
 * — an UNHANDLED `TimeoutError: The operation timed out.` from prod
 * (Kortix API, application_id 2346961), 3 occurrences, 0 users, last seen
 * 2026-07-14 19:34:39 UTC, first seen 2026-06-10. The raw Sentry event carried:
 *
 *   - mechanism: auto.node.onunhandledrejection (handled: false)
 *   - type: TimeoutError, value: "The operation timed out."
 *   - call_site_function / call_site_file: null  (NO JS stack)
 *   - runtime: bun 1.2.23, environment: prod
 *   - url: http://new-api.kortix.com/v1/router/tavily/search
 *
 * Root cause: the /v1/router/tavily/* catch-all billed-upstream proxy returns
 * `new Response(upstream.body, …)` to the client (handlers.ts). When the Tavily
 * upstream stalls mid-response-body, Bun's internal fetch body pump throws a
 * native `TimeoutError` "The operation timed out." with no JS stack. Because the
 * response was already handed to the client, that rejection fires OUTSIDE the
 * request handler's try/catch and Hono's onError, so it surfaces via
 * process.on('unhandledRejection') → captureException → Sentry → Better Stack.
 *
 * It cannot be caught/converted at the JS layer, and the proxy path is
 * request-deadline-exempt (middleware/request-deadline.ts EXEMPT_PREFIXES
 * includes '/v1/router'), so the correct, codebase-consistent fix is to drop
 * this transient upstream/network class in the Sentry ignoreErrors filter — the
 * same pattern sentry.ts already uses for sibling classes (ETIMEDOUT,
 * AbortError, "The operation was aborted", socket-close). This test pins that
 * coverage so a future refactor can't silently re-enable the paging.
 */
import { describe, test, expect } from 'bun:test';
import { SENTRY_IGNORE_ERRORS, isSentryIgnoredError } from '../lib/sentry';

describe('Sentry ignoreErrors noise filter (BS c672fb5e)', () => {
  test('the bare Bun fetch TimeoutError from the Tavily proxy is filtered', () => {
    // Exact type + value from the prod Sentry event (no stack, no call site).
    expect(isSentryIgnoredError('TimeoutError', 'The operation timed out.')).toBe(true);
    // Also covered when only the message is present (how captureException sees
    // a string-coerced reason, or an Error whose .name was stripped).
    expect(isSentryIgnoredError(undefined, 'The operation timed out.')).toBe(true);
  });

  test('the timeout pattern is registered in SENTRY_IGNORE_ERRORS', () => {
    expect(SENTRY_IGNORE_ERRORS).toContain('The operation timed out.');
  });

  test('sibling transient timeout/abort classes remain filtered (no regression)', () => {
    expect(isSentryIgnoredError('Error', 'connect ECONNREFUSED 127.0.0.1:5432')).toBe(true);
    expect(isSentryIgnoredError('Error', 'read ECONNRESET')).toBe(true);
    expect(isSentryIgnoredError('Error', 'connect ETIMEDOUT 1.2.3.4:443')).toBe(true);
    expect(isSentryIgnoredError('AbortError', 'The operation was aborted.')).toBe(true);
    expect(
      isSentryIgnoredError('Error', 'The socket connection was closed unexpectedly'),
    ).toBe(true);
    expect(isSentryIgnoredError('HTTPException', 'Unauthorized')).toBe(true);
  });

  test('a real, actionable error with a distinct message is NOT filtered', () => {
    // Guards against an over-broad filter: a genuine code bug must still page.
    expect(isSentryIgnoredError('TypeError', "Cannot read properties of undefined (reading 'x')"))
      .toBe(false);
    expect(isSentryIgnoredError('Error', 'relation "sessions" does not exist')).toBe(false);
  });

  test('empty type/message is not filtered (never swallow unknown errors)', () => {
    expect(isSentryIgnoredError(undefined, undefined)).toBe(false);
    expect(isSentryIgnoredError('', '')).toBe(false);
  });
});
