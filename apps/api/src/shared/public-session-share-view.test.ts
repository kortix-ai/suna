import { beforeEach, describe, expect, mock, test } from 'bun:test';

let sessionRows: Array<Record<string, unknown>> = [];
let orderedRows: Array<Record<string, unknown>> = [];

mock.module('./db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => sessionRows,
          orderBy: async () => orderedRows,
        }),
      }),
    }),
  },
}));

const { getPublicSessionInfo, getPublicSessionMessages } = await import('./public-session-share-view');

beforeEach(() => {
  sessionRows = [];
  orderedRows = [];
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

  test('reads ACP envelopes from persistence without touching OpenCode even without legacy metadata', async () => {
    sessionRows = [{ metadata: {} }];
    orderedRows = [
      { ordinal: 1, direction: 'client_to_agent', streamEventId: null, createdAt: new Date('2026-01-01'), envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Hello' }] } } },
      { ordinal: 2, direction: 'agent_to_client', streamEventId: 1, createdAt: new Date('2026-01-01'), envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } } } },
    ];

    const result = await getPublicSessionMessages(activeShare);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.runtime_protocol).toBe('acp');
    expect(result.transcript.runtime_session_id).toBeNull();
    expect(result.transcript.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'Hello'],
      ['assistant', 'Hi'],
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('degrades to an unavailable digest (still 200) for non-ACP sessions', async () => {
    sessionRows = [{ metadata: {} }];
    orderedRows = [];
    const result = await getPublicSessionMessages(activeShare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript.available).toBe(false);
      expect(result.transcript.reason).toContain('ACP sessions');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  });
});
