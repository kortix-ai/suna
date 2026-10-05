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

type StateFetch =
  | { ok: true; status: 200; doc: Record<string, unknown>; etag: string | null }
  | { ok: false; reason: string; status: number | null };
type MessagesFetch = { ok: true; messages: unknown[] } | { ok: false; reason: string; status: number | null };

const liveState = (root: string | null): StateFetch => ({
  ok: true,
  status: 200,
  doc: { identity: { opencode_session_id: root } },
  etag: null,
});
let stateResult: StateFetch = liveState('oc-root-1');
let messagesResult: MessagesFetch = { ok: true, messages: [] };
let stateTargets: unknown[] = [];
let messageReads: Array<{ target: unknown; sessionId: string; limit: number }> = [];

mock.module('../projects/lib/session-runtime-transport', () => ({
  fetchRuntimeState: async (target: unknown) => {
    stateTargets.push(target);
    return stateResult;
  },
  fetchRuntimeMessages: async (target: unknown, sessionId: string, options: { limit: number }) => {
    messageReads.push({ target, sessionId, limit: options.limit });
    return messagesResult;
  },
}));

const { getPublicSessionInfo, getPublicSessionMessages } = await import('./public-session-share-view');

beforeEach(() => {
  sessionRows = [];
  stateResult = liveState('oc-root-1');
  messagesResult = { ok: true, messages: [] };
  stateTargets = [];
  messageReads = [];
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

const PUBLIC_MESSAGE_KEYS = ['completed', 'created', 'files', 'reasoning_omitted', 'role', 'text', 'tools'];

describe('getPublicSessionMessages', () => {
  const activeShare = { sessionId: 'sess-1', externalId: 'ext-1', sandboxStatus: 'active' };

  test('503s when the sandbox is not active — never touches the daemon', async () => {
    const result = await getPublicSessionMessages({ ...activeShare, sandboxStatus: 'stopped' });
    expect(result).toEqual({ ok: false, status: 503, error: 'Sandbox is not running' });
    expect(stateTargets).toEqual([]);
    expect(messageReads).toEqual([]);
  });

  test('reads the root the daemon names, anonymously, through the runtime namespace', async () => {
    await getPublicSessionMessages(activeShare);
    expect(stateTargets).toEqual([{ externalId: 'ext-1' }]);
    expect(messageReads).toEqual([{ target: { externalId: 'ext-1' }, sessionId: 'oc-root-1', limit: 200 }]);
  });

  test('falls back to the row pin when the daemon names no root yet', async () => {
    stateResult = liveState(null);
    sessionRows = [{ opencodeSessionId: 'oc-pinned' }];
    const result = await getPublicSessionMessages(activeShare);
    expect(messageReads.map((read) => read.sessionId)).toEqual(['oc-pinned']);
    expect(result.ok && result.transcript.opencode_session_id).toBe('oc-pinned');
  });

  test('degrades to an unavailable digest (still 200) when the daemon is not ready', async () => {
    stateResult = { ok: false, reason: 'daemon_503', status: 503 };
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      expect(result.transcript.reason).toContain('not ready');
    }
    expect(messageReads).toEqual([]);
  });

  test('degrades to unavailable when neither the daemon nor the row names a root', async () => {
    stateResult = liveState(null);
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      expect(result.transcript.opencode_session_id).toBeNull();
    }
    expect(messageReads).toEqual([]);
  });

  test('degrades to unavailable when the sandbox has no service key', async () => {
    stateResult = { ok: false, reason: 'no_service_key', status: null };
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      expect(result.transcript.reason).toBe('Sandbox credentials unavailable');
    }
  });

  test('sanitizes a real message list: joins text parts, strips tool args, keeps only file name+mime', async () => {
    messagesResult = {
      ok: true,
      messages: [
        {
          info: {
            id: 'msg_secret_id',
            role: 'assistant',
            time: { created: 1000, completed: 2000 },
            error: { name: 'ProviderError', message: 'upstream key sk-live-123 rejected' },
          },
          parts: [
            { type: 'text', text: 'first line' },
            { type: 'text', text: 'second line' },
            { type: 'text', text: 'synthetic', synthetic: true },
            { type: 'tool', tool: 'bash', state: { status: 'completed', input: 'rm -rf /', output: 'secret output' } },
            { type: 'file', filename: 'report.pdf', mime: 'application/pdf', content: 'base64-data-should-be-dropped' },
            { type: 'reasoning', text: 'internal thoughts' },
          ],
        },
      ],
    };

    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { transcript } = result;
    expect(transcript.available).toBe(true);
    expect(transcript.source).toBe('live');
    expect(transcript.message_count).toBe(1);
    const [msg] = transcript.messages;
    expect(Object.keys(msg).sort()).toEqual(PUBLIC_MESSAGE_KEYS);
    expect(msg.role).toBe('assistant');
    expect(msg.created).toBe('1970-01-01T00:00:01.000Z');
    expect(msg.text).toBe('first line second line');
    expect(msg.tools).toEqual([{ tool: 'bash', status: 'completed' }]);
    expect(msg.files).toEqual([{ filename: 'report.pdf', mime: 'application/pdf' }]);
    expect(msg.reasoning_omitted).toBe(true);
    const wire = JSON.stringify(msg);
    for (const secret of ['secret output', 'rm -rf', 'base64-data-should-be-dropped', 'msg_secret_id', 'sk-live-123', 'internal thoughts']) {
      expect(wire).not.toContain(secret);
    }
  });

  test('truncates an overlong message body', async () => {
    const longText = 'x'.repeat(5000);
    messagesResult = { ok: true, messages: [{ info: { role: 'user', time: {} }, parts: [{ type: 'text', text: longText }] }] };
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.messages[0].text.length).toBeLessThan(5000);
      expect(result.transcript.messages[0].text.endsWith('…')).toBe(true);
    }
  });

  test('a 503 from the daemon messages read degrades to an unavailable digest, not a hard error', async () => {
    messagesResult = { ok: false, reason: 'daemon_503', status: 503 };
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      expect(result.transcript.reason).toContain('not ready');
      expect(result.transcript.opencode_session_id).toBe('oc-root-1');
    }
  });

  test('a failed daemon read degrades with a generic reason, never the error text', async () => {
    messagesResult = { ok: false, reason: 'ECONNRESET', status: null };
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
    // Regression: resolving the sandbox ingress can throw
    // DaytonaRateLimitError / ThrottlerException when the shared org is
    // throttled. The public share route must NOT 500 or leak the provider
    // text — it degrades to an unavailable digest (sibling of the #3567
    // title-sync fix). The transport turns the throw into a reason; both
    // daemon reads are covered.
    const throttled = { ok: false as const, reason: 'DaytonaRateLimitError: ThrottlerException: Too Many Requests', status: null };
    for (const setup of [
      () => {
        stateResult = throttled;
      },
      () => {
        messagesResult = throttled;
      },
    ]) {
      stateResult = liveState('oc-root-1');
      messagesResult = { ok: true, messages: [] };
      setup();
      const result = await getPublicSessionMessages(activeShare);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.transcript.available).toBe(false);
        expect(result.transcript.reason).not.toContain('ThrottlerException');
        expect(result.transcript.reason).not.toContain('DaytonaRateLimit');
        expect(result.transcript.reason).toBeTruthy();
      }
    }
  });
});

describe('getPublicSessionMessages — saved transcript fallback', () => {
  const activeShare = { sessionId: 'sess-1', externalId: 'ext-1', sandboxStatus: 'active' };
  const mirror = {
    opencode_session_id: 'oc-root-1',
    captured_at: '2026-09-26T00:00:00.000Z',
    total: 2,
    head_complete: true,
    next_cursor: null,
    messages: [
      {
        info: { id: 'msg_1', role: 'user', time: { created: 1000 } },
        parts: [{ type: 'text', text: 'Summarize the launch plan.' }],
      },
      {
        info: { id: 'msg_2', role: 'assistant', time: { created: 2000, completed: 3000 } },
        parts: [
          { type: 'text', text: 'Here is the summary.' },
          { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'cat .env' }, output: 'SECRET=1' } },
          { type: 'reasoning', text: 'private reasoning' },
        ],
      },
    ],
  };
  const readMirror = mock(async () => mirror);

  beforeEach(() => {
    readMirror.mockClear();
  });

  test('a stopped sandbox serves the saved transcript, sanitized, never touching the daemon', async () => {
    const result = await getPublicSessionMessages({ ...activeShare, sandboxStatus: 'stopped' }, { readMirror });
    expect(stateTargets).toEqual([]);
    expect(messageReads).toEqual([]);
    expect(readMirror).toHaveBeenCalledWith('sess-1', 200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { transcript } = result;
    expect(transcript.available).toBe(true);
    expect(transcript.source).toBe('mirror');
    expect(transcript.captured_at).toBe('2026-09-26T00:00:00.000Z');
    expect(transcript.opencode_session_id).toBe('oc-root-1');
    expect(transcript.message_count).toBe(2);
    expect(transcript.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Summarize the launch plan.'],
      ['assistant', 'Here is the summary.'],
    ]);
    expect(Object.keys(transcript.messages[1]).sort()).toEqual(PUBLIC_MESSAGE_KEYS);
    expect(transcript.messages[1].tools).toEqual([{ tool: 'bash', status: 'completed' }]);
    expect(transcript.messages[1].reasoning_omitted).toBe(true);
    const wire = JSON.stringify(transcript);
    expect(wire).not.toContain('SECRET=1');
    expect(wire).not.toContain('cat .env');
    expect(wire).not.toContain('private reasoning');
    expect(wire).not.toContain('msg_2');
  });

  test('a session with no sandbox row serves the saved transcript', async () => {
    const result = await getPublicSessionMessages({ sessionId: 'sess-1', externalId: null, sandboxStatus: null }, { readMirror });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transcript.source).toBe('mirror');
  });

  test('a stopped sandbox with nothing saved → 503', async () => {
    const result = await getPublicSessionMessages(
      { ...activeShare, sandboxStatus: 'stopped' },
      { readMirror: async () => null },
    );
    expect(result).toEqual({ ok: false, status: 503, error: 'Sandbox is not running' });
  });

  test('a running sandbox whose daemon is not ready serves the saved transcript and says why', async () => {
    stateResult = { ok: false, reason: 'daemon_503', status: 503 };
    const result = await getPublicSessionMessages(activeShare, { readMirror });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.available).toBe(true);
    expect(result.transcript.source).toBe('mirror');
    expect(result.transcript.reason).toContain('not ready');
  });

  test('a live read says it is live and carries no capture time', async () => {
    const result = await getPublicSessionMessages(activeShare, { readMirror });
    expect(readMirror).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.source).toBe('live');
    expect(result.transcript.captured_at).toBeNull();
  });

  test('nothing live and nothing saved says so', async () => {
    stateResult = { ok: false, reason: 'timeout', status: null };
    const result = await getPublicSessionMessages(activeShare, { readMirror: async () => null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.available).toBe(false);
    expect(result.transcript.source).toBe('none');
  });
});
