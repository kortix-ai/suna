import { beforeEach, describe, expect, mock, test } from 'bun:test';

let sessionRows: Array<Record<string, unknown>> = [];

mock.module('./db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => sessionRows,
        }),
      }),
    }),
  },
}));

let listResult: { ok: true; sessions: unknown[] } | { ok: false; reason: 'no_key' | 'not_ready' | 'unreachable' } = {
  ok: true,
  sessions: [],
};
let endpointResult: { url: string; headers: Record<string, string> } | null = {
  url: 'http://daemon.local',
  headers: {},
};
// When set, `sandboxOpencodeEndpoint` throws this error instead of resolving —
// simulates a Daytona 429 `ThrottlerException` / archived box on preview-link
// resolution (the post-#3567 recurrence path).
let endpointThrow: Error | null = null;
let resolvedRootId: string | null = 'oc-root-1';

mock.module('../projects/opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => {
    if (endpointThrow) throw endpointThrow;
    return endpointResult;
  },
  listSandboxOpencodeSessions: async () => listResult,
  resolveRootSessionId: () => resolvedRootId,
}));

const { getPublicSessionInfo, getPublicSessionMessages } = await import('./public-session-share-view');

beforeEach(() => {
  sessionRows = [];
  listResult = { ok: true, sessions: [] };
  endpointResult = { url: 'http://daemon.local', headers: {} };
  endpointThrow = null;
  resolvedRootId = 'oc-root-1';
  globalThis.fetch = mock(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
});

describe('getPublicSessionInfo', () => {
  test('404s when the session row does not exist', async () => {
    sessionRows = [];
    const result = await getPublicSessionInfo('sess-missing');
    expect(result).toEqual({ ok: false, status: 404, error: 'Session not found' });
  });

  test('prefers metadata.custom_name over metadata.name', async () => {
    sessionRows = [
      {
        sessionId: 'sess-1',
        status: 'running',
        metadata: { name: 'auto title', custom_name: 'My renamed session' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ];
    const result = await getPublicSessionInfo('sess-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.title).toBe('My renamed session');
      expect(result.session.status).toBe('running');
      expect(result.session.created_at).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  test('falls back to the auto name when there is no custom name', async () => {
    sessionRows = [
      {
        sessionId: 'sess-1',
        status: 'stopped',
        metadata: { name: 'auto title' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];
    const result = await getPublicSessionInfo('sess-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.title).toBe('auto title');
  });

  test('title is null when there is no name at all', async () => {
    sessionRows = [
      {
        sessionId: 'sess-1',
        status: 'queued',
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const result = await getPublicSessionInfo('sess-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.title).toBeNull();
  });
});

describe('getPublicSessionMessages', () => {
  const activeShare = { sessionId: 'sess-1', externalId: 'ext-1', sandboxStatus: 'active' };

  test('503s when the sandbox is not active — never touches the daemon', async () => {
    const result = await getPublicSessionMessages({ ...activeShare, sandboxStatus: 'stopped' });
    expect(result).toEqual({ ok: false, status: 503, error: 'Sandbox is not running' });
  });

  test('degrades to an unavailable digest (still 200) when the daemon reports not_ready', async () => {
    listResult = { ok: false, reason: 'not_ready' };
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      expect(result.transcript.reason).toContain('not ready');
    }
  });

  test('degrades to unavailable when no canonical root session can be resolved', async () => {
    resolvedRootId = null;
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      expect(result.transcript.opencode_session_id).toBeNull();
    }
  });

  test('degrades to unavailable when the sandbox has no service key', async () => {
    endpointResult = null;
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transcript.available).toBe(false);
  });

  test('sanitizes a real message list: joins text parts, strips tool args, keeps only file name+mime', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          {
            info: { role: 'assistant', time: { created: 1000, completed: 2000 } },
            parts: [
              { type: 'text', text: 'first line' },
              { type: 'text', text: 'second line' },
              { type: 'text', text: 'synthetic', synthetic: true },
              { type: 'tool', tool: 'bash', state: { status: 'completed', input: 'rm -rf /', output: 'secret output' } },
              { type: 'file', filename: 'report.pdf', mime: 'application/pdf', content: 'base64-data-should-be-dropped' },
              { type: 'reasoning', text: 'internal thoughts' },
            ],
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { transcript } = result;
    expect(transcript.available).toBe(true);
    expect(transcript.message_count).toBe(1);
    const [msg] = transcript.messages;
    expect(msg.role).toBe('assistant');
    expect(msg.text).toBe('first line second line');
    expect(msg.tools).toEqual([{ tool: 'bash', status: 'completed' }]);
    expect(msg.files).toEqual([{ filename: 'report.pdf', mime: 'application/pdf' }]);
    expect(msg.reasoning_omitted).toBe(true);
    expect(JSON.stringify(msg)).not.toContain('secret output');
    expect(JSON.stringify(msg)).not.toContain('base64-data-should-be-dropped');
  });

  test('truncates an overlong message body', async () => {
    const longText = 'x'.repeat(5000);
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify([{ info: { role: 'user', time: {} }, parts: [{ type: 'text', text: longText }] }]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.messages[0].text.length).toBeLessThan(5000);
      expect(result.transcript.messages[0].text.endsWith('…')).toBe(true);
    }
  });

  test('a 503 from the daemon degrades to an unavailable digest, not a hard error', async () => {
    globalThis.fetch = mock(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transcript.available).toBe(false);
  });

  test('a daemon fetch throw degrades to an unavailable digest instead of propagating', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      // Anonymous audience: the raw daemon error text must NOT leak — generic
      // reason only (the detail is logged server-side).
      expect(result.transcript.reason).not.toContain('ECONNRESET');
      expect(result.transcript.reason).toBeTruthy();
    }
  });

  test('a Daytona 429 rate-limit on endpoint resolution degrades to unavailable (post-#3567 regression)', async () => {
    // Regression: sandboxOpencodeEndpoint resolves the Daytona preview link,
    // which throws DaytonaRateLimitError / ThrottlerException when the shared
    // org is throttled. The public share route must NOT 500 / surface an
    // unhandled Sentry event — it must degrade to an unavailable digest
    // (sibling of the #3567 title-sync fix; this is the post-#3567 call site
    // that was left unguarded).
    endpointThrow = new Error('DaytonaRateLimitError: ThrottlerException: Too Many Requests');
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      // Anonymous audience: the raw provider error text must NOT leak.
      expect(result.transcript.reason).not.toContain('ThrottlerException');
      expect(result.transcript.reason).not.toContain('DaytonaRateLimit');
      expect(result.transcript.reason).toBeTruthy();
      expect(result.transcript.opencode_session_id).toBe('oc-root-1');
    }
  });
});
