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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  // ── Regression: BS pattern 28e9a65c… — `new URL()` on a path-only
  // `req.url` (no-Host scanner probes) throws
  // `TypeError: "…" cannot be parsed as a URL.`. The root-cause fix
  // (lib/request-url.ts ensureAbsoluteRequestUrl) prevents the throw on the
  // request path; this filter is defense-in-depth so any residual edge case
  // stops paging.
  test('the URL-parse TypeError from path-only scanner URLs is filtered', () => {
    expect(isSentryIgnoredError('TypeError', '"/" cannot be parsed as a URL.')).toBe(true);
    expect(
      isSentryIgnoredError(
        'TypeError',
        '"/nice%20ports%2C/Tri%6Eity.txt%2ebak" cannot be parsed as a URL.',
      ),
    ).toBe(true);
    // Also covered when only the message is present (string-coerced reason).
    expect(isSentryIgnoredError(undefined, '"/" cannot be parsed as a URL.')).toBe(true);
  });

  test('the URL-parse pattern is registered in SENTRY_IGNORE_ERRORS', () => {
    expect(SENTRY_IGNORE_ERRORS).toContain('cannot be parsed as a URL');
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

  // ── Regression: BS pattern 721b7efe… (API) + b38179c5… (frontend symptom)
  // — Supabase pooler / PgBouncer session-mode pool exhaustion on the
  // us-east-2 shadow deployment. The `postgres@3.4.9` driver surfaces it as a
  // `PostgresError` whose message reads
  // `(EMAXCONNSESSION) max clients reached in session mode - max clients are
  // limited to pool_size: 20`. It is a TRANSIENT pool-saturation class (the
  // `FreeTierRotation`/`YearlyRotation` cron ticks + `llm-gateway` catalog
  // loads + a user `GET /v1/projects` contending for the 20-session pool),
  // NOT a code bug — `pool_size` is a Supabase-pooler config. The
  // `index.ts` DB-error handler unconditionally `captureException`d it → paged
  // Sentry → the frontend surfaced the 500 as `ApiError: Internal server
  // error`. The fix classifies it as transient (skip Sentry capture) while
  // STILL logging + STILL 500. Mirrors #5167/#5175 (Daytona transient
  // no-capture) + #4709 (ignore list).
  test('the Supabase pool-exhaustion PostgresError is filtered (exact prod message)', () => {
    // Exact message from the prod Sentry event (Better Stack 721b7efe…).
    expect(
      isSentryIgnoredError(
        'PostgresError',
        '(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 20',
      ),
    ).toBe(true);
    // Stable, deploy-agnostic substring (pool_size suffix is config-specific).
    expect(isSentryIgnoredError('PostgresError', 'max clients reached in session mode')).toBe(true);
    // Driver code anchor (robust across driver versions).
    expect(isSentryIgnoredError('PostgresError', 'EMAXCONNSESSION')).toBe(true);
    // Also covered when only the message is present (string-coerced reason).
    expect(isSentryIgnoredError(undefined, 'max clients reached in session mode')).toBe(true);
  });

  test('the pool-exhaustion patterns are registered in SENTRY_IGNORE_ERRORS', () => {
    expect(SENTRY_IGNORE_ERRORS).toContain('max clients reached in session mode');
    expect(SENTRY_IGNORE_ERRORS).toContain('EMAXCONNSESSION');
  });

  test('a real DB schema/SQL bug is NOT filtered (do not over-match PostgresError)', () => {
    // Guards against an over-broad filter: a genuine PostgresError (missing
    // relation, syntax error) must still page Sentry via the DB-error handler.
    expect(isSentryIgnoredError('PostgresError', 'relation "kortix.foo" does not exist')).toBe(
      false,
    );
    expect(isSentryIgnoredError('PostgresError', 'syntax error at or near "SELECT"')).toBe(false);
  });
});

// ── Source-level guard: the `index.ts` DB-error handler must skip
// `captureException` for pool-exhaustion (the DIRECT call bypasses the
// `ignoreErrors` list, which only filters automatic/unhandled captures).
// Mirrors the repo's existing source-guard test convention (e.g. the
// `seedDraft` source-structure pin). Asserts the guard structure is present so
// a future refactor can't silently re-enable the paging.
describe('index.ts DB-error handler pool-exhaustion guard (BS 721b7efe)', () => {
  const indexSrc = readFileSync(
    fileURLToPath(new URL('../index.ts', import.meta.url)),
    'utf8',
  );

  test('imports isSentryIgnoredError from lib/sentry', () => {
    expect(indexSrc).toContain('isSentryIgnoredError');
    expect(indexSrc).toMatch(/import\s*\{[^}]*\bisSentryIgnoredError\b[^}]*\}\s*from\s*['"]\.\/lib\/sentry['"]/);
  });

  test('the DB-error handler guards captureException with isSentryIgnoredError', () => {
    // The guard must classify via isSentryIgnoredError and conditionally skip
    // the captureException call (defense in depth — the ignoreErrors list
    // alone does NOT stop a direct captureException).
    expect(indexSrc).toContain("const isPoolExhaustion = isSentryIgnoredError(errName, err.message)");
    expect(indexSrc).toContain('if (!isPoolExhaustion)');
    // The structured log still fires (transient: true / errorType tag) so the
    // event stays observable without paging.
    expect(indexSrc).toContain("'database-pool-exhaustion'");
    expect(indexSrc).toContain('transient: isPoolExhaustion');
  });
});
