import { describe, expect, mock, test } from 'bun:test';

/**
 * Closing a channel card is not the same as ending the run.
 *
 * On dev 2026-09-19 a Teams turn died mid-flight: the ledger settled it
 * `runtime_gone`, the 30-minute GC closed the Adaptive Card, and OpenCode kept
 * an assistant message OPEN — `time.created` set, `time.completed` absent —
 * for two days. Every later message in that conversation was accepted by
 * `prompt_async` and never run; two of the user's messages vanished with
 * nothing shown to them. `POST /session/:id/abort` is what unwedges it.
 */

const calls: Array<{ url: string; method: string | undefined }> = [];
let endpoint: { endpoint: { url: string; headers: Record<string, string> }; opencodeSessionId: string } | null = {
  endpoint: { url: 'https://box.test/p/abc/4096', headers: { 'x-kortix': '1' } },
  opencodeSessionId: 'ses_123',
};
let ok = true;
let throws = false;
const marks: Array<{ sessionId: string; name: string; opencodeSessionId?: string | null }> = [];
let markThrows = false;
/** The order of the stop mark and the abort request, across both fakes. */
const order: string[] = [];

describe('abortRuntimeTurn', () => {
  test('posts abort to the session the runtime is holding', async () => {
    calls.length = 0;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    expect(await abortRuntimeTurn('kortix-session-1')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://box.test/p/abc/4096/session/ses_123/abort?directory=%2Fworkspace');
  });

  test('an empty session id does nothing', async () => {
    calls.length = 0;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    expect(await abortRuntimeTurn('')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('a session with no reachable runtime is a no-op, not a throw', async () => {
    calls.length = 0;
    endpoint = null;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    expect(await abortRuntimeTurn('kortix-session-1')).toBe(false);
    expect(calls).toHaveLength(0);
    endpoint = {
      endpoint: { url: 'https://box.test/p/abc/4096', headers: {} },
      opencodeSessionId: 'ses_123',
    };
  });

  // The caller is a housekeeping sweep that already decided the turn is dead.
  // A parked or slow box must never fail it.
  test.each([
    ['a refusing runtime', { ok: false, throws: false }],
    ['a network error', { ok: true, throws: true }],
  ])('%s reports false instead of throwing', async (_label, runtime) => {
    ok = runtime.ok;
    throws = runtime.throws;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    try {
      expect(await abortRuntimeTurn('kortix-session-1')).toBe(false);
    } finally {
      ok = true;
      throws = false;
    }
  });

  // A Stop from Slack or Teams aborts the runtime directly, never through the
  // sandbox proxy that stamps `UserStop`. Unstamped, the abort it causes reads
  // as a failure nobody explained under the turn the user stopped.
  test('a requested stop is stamped on the open turn before the abort', async () => {
    calls.length = 0;
    marks.length = 0;
    order.length = 0;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    expect(await abortRuntimeTurn('kortix-session-1', { requestedStop: true })).toBe(true);
    expect(marks).toEqual([{ sessionId: 'kortix-session-1', name: 'UserStop', opencodeSessionId: 'ses_123' }]);
    expect(calls).toHaveLength(1);
    // Stamped first: the abort ends the turn, and a mark that lands after the
    // end never explains it.
    expect(order).toEqual(['mark', 'fetch']);
  });

  test('a housekeeping abort stamps nothing', async () => {
    marks.length = 0;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    await abortRuntimeTurn('kortix-session-1');
    expect(marks).toEqual([]);
  });

  test('a stamp that fails never blocks the stop', async () => {
    calls.length = 0;
    markThrows = true;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    expect(await abortRuntimeTurn('kortix-session-1', { requestedStop: true })).toBe(true);
    expect(calls).toHaveLength(1);
    markThrows = false;
  });
});

mock.module('../projects/session-lifecycle/runtime-client', () => ({
  resolveSessionOpencodeEndpoint: async () => endpoint,
}));

mock.module('../projects/sandbox-turn-lifecycle', () => ({
  markTurnStopRequested: async (sessionId: string, name: string, scope: { opencodeSessionId?: string | null }) => {
    if (markThrows) throw new Error('db down');
    marks.push({ sessionId, name, opencodeSessionId: scope.opencodeSessionId });
    order.push('mark');
  },
}));

mock.module('../projects/sandbox-fetch', () => ({
  sandboxRuntimeRequestHeaders: (h: Record<string, string>) => h,
}));

globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
  if (throws) throw new Error('ECONNREFUSED');
  calls.push({ url: String(url), method: init?.method });
  order.push('fetch');
  return { ok } as Response;
}) as typeof fetch;
