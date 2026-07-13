import { beforeEach, describe, expect, mock, test } from 'bun:test';

type StoredRow = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId: string | null;
  envelope: Record<string, unknown>;
  createdAt: Date;
};

let transcriptRows: StoredRow[] = [];
let selectCalls = 0;

mock.module('../shared/db', () => ({
  db: {
    select: () => {
      selectCalls += 1;
      return {
        from: () => ({
          where: () => ({
            orderBy: async () => transcriptRows,
          }),
        }),
      };
    },
  },
}));

const { buildSessionTranscriptDigest } = await import('../projects/lib/session-transcript');

beforeEach(() => {
  transcriptRows = [];
  selectCalls = 0;
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    accountId: 'account-1',
    status: 'running',
    metadata: {
      runtime_protocol: 'acp',
      acp_session_id: 'acp-session-1',
    },
    ...overrides,
  } as any;
}

describe('buildSessionTranscriptDigest', () => {
  test('projects persisted ACP envelopes without calling a harness-native API', async () => {
    transcriptRows = [
      {
        ordinal: 1,
        direction: 'client_to_agent',
        streamEventId: null,
        envelope: {
          jsonrpc: '2.0',
          id: 1,
          method: 'session/prompt',
          params: { prompt: [{ type: 'text', text: 'Fix it' }] },
        },
        createdAt: new Date('2026-07-13T12:00:00.000Z'),
      },
      {
        ordinal: 2,
        direction: 'agent_to_client',
        streamEventId: 'evt-2',
        envelope: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Done' },
            },
          },
        },
        createdAt: new Date('2026-07-13T12:00:01.000Z'),
      },
    ];

    const result = await buildSessionTranscriptDigest({
      session: session(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });

    expect(result.available).toBe(true);
    expect(result.runtime_session_id).toBe('acp-session-1');
    expect(result.message_count).toBe(2);
    expect(result.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'Fix it'],
      ['assistant', 'Done'],
    ]);
    expect(selectCalls).toBe(1);
    expect('opencode_session_id' in result).toBe(false);
  });

  test('returns an explicit unavailable digest for a non-ACP legacy session', async () => {
    const result = await buildSessionTranscriptDigest({
      session: session({ metadata: {} }),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });

    expect(result).toEqual({
      available: false,
      reason: 'Transcript export is only available for ACP sessions.',
      runtime_session_id: null,
      message_count: 0,
      messages: [],
    });
    expect(selectCalls).toBe(0);
  });
});
