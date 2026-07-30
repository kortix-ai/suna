import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// When set, `sandboxOpencodeEndpoint` throws this error instead of resolving —
// simulates a Daytona 429 `ThrottlerException` / archived box on preview-link
// resolution (the post-#3567 recurrence path).
let endpointThrow: Error | null = null;
let endpointResult: { url: string; headers: Record<string, string> } | null = {
  url: 'http://daemon.local',
  headers: {},
};
let ensuredPin: string | null = 'oc-root-1';
let ensuredReason: 'unchanged' | 'healed' | 'not_ready' | 'unreachable' = 'unchanged';
let sandboxCalls: string[] = [];
let storedEnvelopes: unknown[] = [];
let acpTranscriptCalls: Array<{ projectId: string; sessionId: string }> = [];

mock.module('../projects/opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => {
    sandboxCalls.push('sandboxOpencodeEndpoint');
    if (endpointThrow) throw endpointThrow;
    return endpointResult;
  },
  ensureOpencodeSessionPin: async () => {
    sandboxCalls.push('ensureOpencodeSessionPin');
    return {
      pin: ensuredPin,
      changed: false,
      reason: ensuredReason,
      sessions: [],
    };
  },
}));

mock.module('../projects/lib/acp-transcript', () => ({
  loadAcpTranscript: async (input: { projectId: string; sessionId: string }) => {
    acpTranscriptCalls.push(input);
    return storedEnvelopes;
  },
}));

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
  },
}));

const { buildSessionTranscriptDigest } = await import('../projects/lib/session-transcript');

beforeEach(() => {
  sandboxCalls = [];
  acpTranscriptCalls = [];
  storedEnvelopes = [];
});

afterEach(() => {
  endpointThrow = null;
  endpointResult = { url: 'http://daemon.local', headers: {} };
  ensuredPin = 'oc-root-1';
  ensuredReason = 'unchanged';
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    accountId: 'account-1',
    opencodeSessionId: 'oc-root-1',
    status: 'running',
    // Embeds the external id (/p/<externalId>/) so resolveSessionExternalId
    // short-circuits without a DB hit.
    sandboxUrl: 'https://preview.kortix.com/v1/p/sandbox-ext-1/8000',
    metadata: {},
    ...overrides,
  } as any;
}

function acpSession(overrides: Record<string, unknown> = {}) {
  return session({
    opencodeSessionId: null,
    status: 'stopped',
    sandboxUrl: null,
    metadata: {
      runtime_transport: 'acp',
      runtime_harness: 'opencode',
      acp_server_id: 'acp-server-1',
      acp_session_id: 'ses_1',
    },
    ...overrides,
  });
}

function envelope(body: Record<string, unknown>, ordinal: number) {
  return {
    ordinal,
    direction: 'agent_to_client' as const,
    streamEventId: ordinal,
    envelope: body,
    createdAt: '2026-07-30T00:00:00.000Z',
  };
}

describe('buildSessionTranscriptDigest', () => {
  test('degrades to an unavailable digest when endpoint resolution throws a Daytona 429 (post-#3567 regression)', async () => {
    // Regression: sandboxOpencodeEndpoint resolves the Daytona preview link,
    // which throws DaytonaRateLimitError / ThrottlerException when the shared
    // org is throttled. The transcript read must NOT 500 / surface an unhandled
    // Sentry event — it must degrade to an unavailable digest (sibling of the
    // #3567 title-sync fix; this is the post-#3567 call site that was left
    // unguarded).
    endpointThrow = new Error('DaytonaRateLimitError: ThrottlerException: Too Many Requests');
    const result = await buildSessionTranscriptDigest({
      session: session(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result.available).toBe(false);
    expect(result.message_count).toBe(0);
    expect(result.opencode_session_id).toBe('oc-root-1');
    // The provider error is surfaced as a controlled reason (NOT propagated),
    // so the route returns a 200 unavailable digest instead of 500ing.
    expect(result.reason).toContain('could not reach sandbox');
    expect(result.reason).toContain('ThrottlerException');
  });

  test('degrades to unavailable when the sandbox has no service key', async () => {
    endpointResult = null;
    const result = await buildSessionTranscriptDigest({
      session: session(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('service key');
  });

  test('returns a real transcript when the daemon answers', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          {
            info: { role: 'assistant', time: { created: 1000, completed: 2000 } },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await buildSessionTranscriptDigest({
      session: session(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result.available).toBe(true);
    expect(result.message_count).toBe(1);
    expect(result.messages[0].text).toBe('hello');
  });

  test('a REST session digest keeps the exact pre-ACP shape and never reads the envelope log', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          {
            info: { role: 'assistant', time: { created: 1000, completed: 2000 } },
            parts: [
              { type: 'text', text: 'first line' },
              { type: 'text', text: 'synthetic', synthetic: true },
              { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'secret output' } },
              { type: 'file', filename: 'report.pdf', mime: 'application/pdf' },
              { type: 'reasoning', text: 'internal' },
            ],
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await buildSessionTranscriptDigest({
      session: session(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result).toEqual({
      available: true,
      reason: null,
      opencode_session_id: 'oc-root-1',
      message_count: 1,
      messages: [
        {
          role: 'assistant',
          created: '1970-01-01T00:00:01.000Z',
          completed: '1970-01-01T00:00:02.000Z',
          text: 'first line',
          tools: [{ tool: 'bash', status: 'completed' }],
          files: [{ filename: 'report.pdf', mime: 'application/pdf' }],
          reasoning_omitted: true,
          error: null,
        },
      ],
    });
    expect(acpTranscriptCalls).toEqual([]);
  });

  test('serves an ACP session from the envelope log without any sandbox call', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('the ACP transcript must never touch the sandbox');
    }) as unknown as typeof fetch;
    storedEnvelopes = [
      envelope(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'session/prompt',
          params: { sessionId: 'ses_1', prompt: [{ type: 'text', text: 'ship it' }] },
        },
        1,
      ),
      envelope(
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', status: 'completed', kind: 'execute' },
          },
        },
        2,
      ),
      envelope(
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'shipped' } },
          },
        },
        3,
      ),
      envelope({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } }, 4),
    ];

    const result = await buildSessionTranscriptDigest({
      session: acpSession(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });

    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.opencode_session_id).toBeNull();
    expect(result.message_count).toBe(2);
    expect(result.messages[0]).toMatchObject({ role: 'user', text: 'ship it' });
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'shipped',
      tools: [{ tool: 'bash', status: 'completed' }],
    });
    expect(acpTranscriptCalls).toEqual([{ projectId: 'project-1', sessionId: 'session-1' }]);
    expect(sandboxCalls).toEqual([]);
  });

  test('serves an ACP session whose sandbox is stopped, because the envelope log outlives it', async () => {
    storedEnvelopes = [
      envelope(
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'still here' } },
          },
        },
        1,
      ),
    ];
    const result = await buildSessionTranscriptDigest({
      session: acpSession({ status: 'stopped' }),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result.available).toBe(true);
    expect(result.messages[0].text).toBe('still here');
    expect(sandboxCalls).toEqual([]);
  });

  test('an ACP session with zero envelopes is empty-but-available, not an error', async () => {
    storedEnvelopes = [];
    const result = await buildSessionTranscriptDigest({
      session: acpSession(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result).toEqual({
      available: true,
      reason: null,
      opencode_session_id: null,
      message_count: 0,
      messages: [],
    });
  });

  test('reads the envelope log for every ACP harness, not just opencode', async () => {
    storedEnvelopes = [
      envelope(
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'from claude' } },
          },
        },
        1,
      ),
    ];
    for (const harness of ['claude', 'codex', 'pi'] as const) {
      const result = await buildSessionTranscriptDigest({
        session: acpSession({
          metadata: {
            runtime_transport: 'acp',
            runtime_harness: harness,
            acp_server_id: 'acp-server-1',
            acp_session_id: 'ses_1',
          },
        }),
        projectId: 'project-1',
        accountId: 'account-1',
        userId: 'user-1',
        limit: 40,
        maxChars: 700,
      });
      expect(result.available).toBe(true);
      expect(result.messages[0].text).toBe('from claude');
    }
    expect(sandboxCalls).toEqual([]);
  });
});
