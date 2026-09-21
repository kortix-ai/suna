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
  test('a refusing runtime reports false instead of throwing', async () => {
    ok = false;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    expect(await abortRuntimeTurn('kortix-session-1')).toBe(false);
    ok = true;
  });

  test('a network error reports false instead of throwing', async () => {
    throws = true;
    const { abortRuntimeTurn } = await import('../projects/session-lifecycle/abort-runtime-turn');
    expect(await abortRuntimeTurn('kortix-session-1')).toBe(false);
    throws = false;
  });
});

mock.module('../projects/session-lifecycle/engine', () => ({
  resolveSessionOpencodeEndpoint: async () => endpoint,
}));

mock.module('../projects/sandbox-fetch', () => ({
  sandboxRuntimeRequestHeaders: (h: Record<string, string>) => h,
}));

globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
  if (throws) throw new Error('ECONNREFUSED');
  calls.push({ url: String(url), method: init?.method });
  return { ok } as Response;
}) as typeof fetch;
