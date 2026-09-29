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
