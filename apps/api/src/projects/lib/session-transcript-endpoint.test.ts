import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { MirrorSnapshot } from './session-transcript-mirror';

/**
 * The live transcript read resolves the sandbox's daemon endpoint ONCE per
 * request — the pin check and the message fetch share it — and that shared
 * resolution is bounded: a hung provider or box degrades to the mirror at the
 * budget instead of stacking waits into the 25 s request deadline. The
 * sandbox-proxy backend (the Daytona/provider hops) stands in for the
 * provider here; it is the slow, cached side of the resolution.
 *
 * 2026-09-29 prod: GET /v1/projects/:id/sessions/:id/transcript answered
 * 25 s deadline 503s and 20–25 s reads while two resolutions (the pin
 * check's own + the digest's) stacked two provider timeouts each.
 */

let resolveServiceKeyCalls = 0;
let resolveServiceKeyHang = false;

const realBackend = await import('../../sandbox-proxy/backend');
mock.module('../../sandbox-proxy/backend', () => ({
  ...realBackend,
  resolveServiceKey: async () => {
    resolveServiceKeyCalls += 1;
    if (resolveServiceKeyHang) return new Promise<null>(() => {});
    return 'service-key';
  },
  resolveSandboxIngress: async () => ({
    url: 'http://daemon.test',
    headers: {},
    effectivePort: 8000,
  }),
}));

const realPreviewOwnership = await import('../../shared/preview-ownership');
mock.module('../../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  resolvePreviewUserContext: async () => null,
}));

const realLogger = await import('../../lib/logger');

const { buildSessionTranscriptDigest } = await import('./session-transcript');

const runningSession = {
  sessionId: 'sess-1',
  status: 'running',
  opencodeSessionId: 'ses_root',
  // `sandboxUrl` names the external id, so no sandbox row lookup runs.
  sandboxUrl: 'https://preview.example.test/v1/p/sandbox-ext-1/8000',
} as never;

const mirrorSnapshot = () =>
  ({
    opencode_session_id: 'ses_mirror',
    captured_at: '2026-09-29T06:00:00.000Z',
    total: 1,
    head_complete: true,
    next_cursor: null,
    messages: [
      {
        info: { id: 'msg_1', role: 'user', time: { created: 1000 } },
        parts: [{ id: 'p1', type: 'text', text: 'ping' }],
      },
    ],
  }) as never;

const digest = (over: Record<string, unknown> = {}, mirror: unknown = null) =>
  buildSessionTranscriptDigest(
    {
      session: runningSession,
      projectId: 'proj-1',
      accountId: 'acct-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
      ...over,
    } as never,
    { readMirror: async () => mirror as MirrorSnapshot | null },
  );

afterEach(() => {
  resolveServiceKeyCalls = 0;
  resolveServiceKeyHang = false;
});

describe('the live read resolves the sandbox endpoint once', () => {
  test('the pin check and the message fetch share one resolution', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: Parameters<typeof fetch>[0],
    ) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/session')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(
        JSON.stringify([
          {
            info: { role: 'assistant', time: { created: 1000, completed: 2000 } },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch);
    try {
      const result = await digest();
      expect(result.source).toBe('live');
      // One resolution, not one per stage: two resolutions stacked two
      // provider timeouts into a single read during the 2026-09-29 spike.
      expect(resolveServiceKeyCalls).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('a hung sandbox endpoint resolution degrades at the budget', () => {
  test('a provider that never answers becomes a mirror read, not a hang', async () => {
    resolveServiceKeyHang = true;
    const started = Date.now();
    const result = await digest({ endpointBudgetMs: 150 }, mirrorSnapshot());
    // The degrade, not the hang: on the unbounded code this test's own
    // timeout is the failure, and the read never answers at all.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.available).toBe(true);
    expect(result.source).toBe('mirror');
    expect(result.reason).toContain('could not reach sandbox');
    expect(result.reason).toContain('timed out');
    expect(resolveServiceKeyCalls).toBe(1);
  });

  test('the degrade line is rate-limited: first occurrence reported, the rest suppressed for the interval', async () => {
    // KRTX-614 class: a wedged box during a burst degrades every read. One
    // line per degrade would read as a new log-pattern spike; the line
    // reports the first occurrence and at most one per interval.
    const lines: unknown[] = [];
    const logSpy = spyOn(realLogger.logger, 'info').mockImplementation(((message: string) => {
      if (message.startsWith('[transcript] live read degraded')) {
        lines.push(message);
      }
    }) as unknown as typeof realLogger.logger.info);
    // The throttle's clock is the same Date.now the previous tests used, so
    // this one starts its window far in the future of anything they logged.
    let clock = Date.now() + 10_000_000;
    const dateSpy = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      // Two degrades inside one interval: the first is reported.
      resolveServiceKeyHang = true;
      await digest({ endpointBudgetMs: 50 }, mirrorSnapshot());
      clock += 1_000;
      await digest({ endpointBudgetMs: 50 }, mirrorSnapshot());
      expect(lines).toHaveLength(1);

      // Past the interval, the next degrade is reported again.
      clock += 61_000;
      await digest({ endpointBudgetMs: 50 }, mirrorSnapshot());
      expect(lines).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });
});
