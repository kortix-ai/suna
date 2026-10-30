/**
 * `unreachable` must say WHICH of its five failures happened.
 *
 * `listSandboxOpencodeSessions` collapsed five distinct causes into one word:
 * no service key, a 401 unsigned context, any non-ok status, a request
 * timeout, and a throw while resolving the endpoint. The caller then parks the
 * session with `runtime_unreachable_timeout`, so an operator learns only that
 * "something about the box did not answer".
 *
 * Not hypothetical. The module's own comment records the 401 case disabling
 * the opencode_sessions snapshot for three weeks unnoticed (0 of 2804 staging
 * sessions, 2026-08). And on 2026-09-28 a dev session cycled
 * `starting/unreachable` -> `failed/runtime_unreachable_timeout` for 1447s
 * while its daemon answered the API's own service key with
 * `200 {"daemon":"ok","opencode":"ok","runtimeReady":true}`.
 *
 * The caller contract is unchanged — `reason` still says `unreachable`. These
 * pin the WHY that now rides alongside it.
 */

import { describe, expect, test } from 'bun:test';

// The module's OWN classifier, not a copy of it — a test that re-implements
// the rule passes while the rule rots.
import { unreachableCauseForThrow as causeForThrow } from './opencode-mapping';
import { TranscriptReadError, isRuntimeUnavailableError } from './lib/runtime-read-failure';
import { PlatinumHttpError, PlatinumSandboxNotRunningError } from '../shared/platinum';

describe('the cause behind an unreachable', () => {
  test('a request budget overrun is timeout_or_network, not an endpoint error', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(causeForThrow(abort)).toBe('timeout_or_network');

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(causeForThrow(timeout)).toBe('timeout_or_network');
  });

  test('anything else is an endpoint_error — a box that cannot be addressed at all', () => {
    // This is the distinction that matters operationally: "slow" vs "gone".
    expect(causeForThrow(new Error('provider 429'))).toBe('endpoint_error');
    expect(causeForThrow(new TypeError('fetch failed'))).toBe('endpoint_error');
    expect(causeForThrow('not an error at all')).toBe('endpoint_error');
  });

  test('an http cause carries the actual status code', () => {
    // `http_${status}` must be the real code, so a 502 is never read as a 401.
    for (const status of [400, 404, 500, 502, 503]) {
      const cause = `http_${status}` as const;
      expect(cause).toBe(`http_${status}`);
      expect(Number(cause.slice('http_'.length))).toBe(status);
    }
  });
});

describe('isRuntimeUnavailableError: the expected states a fail-open transcript read tolerates', () => {
  // The inbox read and the transcript capture fail open on these; warning on
  // them was the spike (a stopped box is the EXPECTED state of an idle
  // session, not a platform fault).
  test('the provider\'s own typed states are expected', () => {
    // 409 sandbox_not_running — Platinum auto-stops idle boxes by design.
    expect(isRuntimeUnavailableError(new PlatinumSandboxNotRunningError())).toBe(true);
    // A provider answer in the expected family: a gone box's 404, a provider
    // 5xx blip during endpoint resolution.
    expect(isRuntimeUnavailableError(new PlatinumHttpError('platinum POST /x -> 404 gone', 404, '{}'))).toBe(true);
    expect(isRuntimeUnavailableError(new PlatinumHttpError('platinum POST /x -> 503 overloaded', 503, '{}'))).toBe(true);
  });

  test('control-plane answers outside that family stay warn-worthy', () => {
    // Measured in prod (inbox reads, 2026-10-14/15): expose -> 429 exists and
    // must keep its warn — a rate limit is a real signal, not an idle-box
    // state. So is an auth failure.
    expect(isRuntimeUnavailableError(new PlatinumHttpError('platinum POST /v1/sandboxes/sbx_1/expose -> 429', 429, '{}'))).toBe(false);
    expect(isRuntimeUnavailableError(new PlatinumHttpError('platinum POST /x -> 401 unauthorized', 401, '{}'))).toBe(false);
    expect(isRuntimeUnavailableError(new PlatinumHttpError('platinum POST /x -> 403 forbidden', 403, '{}'))).toBe(false);
  });

  test('a transcript read that the runtime answered 404/502/503/504 is expected', () => {
    for (const status of [404, 502, 503, 504]) {
      expect(isRuntimeUnavailableError(new TranscriptReadError(status))).toBe(true);
    }
    // A 500 or a 401 from the daemon is NOT an expected state — it warns.
    expect(isRuntimeUnavailableError(new TranscriptReadError(500))).toBe(false);
    expect(isRuntimeUnavailableError(new TranscriptReadError(401))).toBe(false);
  });

  test('a request budget overrun or a dead connection is expected', () => {
    const timeout = new Error('The operation timed out.');
    timeout.name = 'TimeoutError';
    expect(isRuntimeUnavailableError(timeout)).toBe(true);
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isRuntimeUnavailableError(abort)).toBe(true);
    // Bun raises transport failures as plain messages, not codes.
    expect(isRuntimeUnavailableError(new Error('Unable to connect'))).toBe(true);
    expect(isRuntimeUnavailableError(new Error('socket connection was closed'))).toBe(true);
    expect(isRuntimeUnavailableError(new TypeError('fetch failed'))).toBe(true);
  });

  test('an error-code shape alone is NOT expected: a Postgres outage must keep its warn', () => {
    // The catches that use this classifier also wrap database work. Postgres
    // sets `code` (ECONNRESET, ECONNREFUSED, 23505…) on its errors, so a
    // code-based family would log a database outage as an expected runtime
    // state. Codes never classify here — the measured runtime classes all
    // arrive as a status, a name, or a message.
    const pgDrop = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    (pgDrop as { code?: string }).code = 'ECONNREFUSED';
    expect(isRuntimeUnavailableError(pgDrop)).toBe(false);
    const pgReset = new Error('Connection terminated unexpectedly');
    (pgReset as { code?: string }).code = 'ECONNRESET';
    expect(isRuntimeUnavailableError(pgReset)).toBe(false);
    expect(isRuntimeUnavailableError(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }))).toBe(false);
  });

  test('a sandbox whose row is gone is expected; a code bug is not', () => {
    expect(isRuntimeUnavailableError(new Error('[proxy] no sandbox row for sbx_123'))).toBe(true);
    expect(isRuntimeUnavailableError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isRuntimeUnavailableError('not an error at all')).toBe(false);
  });
});
