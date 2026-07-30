import { describe, expect, test } from 'bun:test';

import {
  acpEndpointForSession,
  acpSessionTargetFromSession,
  assistantReplyAfter,
  projectEnvelopes,
  sendAcpPromptAndWait,
} from './acp-session.ts';
import type { Auth } from './auth.ts';
import type { ProjectSession } from './types.ts';

function auth(overrides: Partial<Auth> = {}): Auth {
  return {
    api_base: 'http://localhost:14108',
    token: 'kortix_pat_test',
    user_id: 'u1',
    user_email: 'u@example.com',
    account_id: 'a1',
    logged_in_at: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

function session(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 'sess-1',
    acp_server_id: 'sess-1',
    acp_session_id: 'ses_native_1',
    runtime_harness: 'opencode',
    native_agent: null,
    status: 'running',
    ...overrides,
  } as ProjectSession;
}

describe('acpEndpointForSession', () => {
  test('builds the durable platform ACP endpoint, not an in-sandbox bridge url', () => {
    expect(acpEndpointForSession(auth(), 'proj-1', 'sess-1')).toBe(
      'http://localhost:14108/v1/projects/proj-1/sessions/sess-1/acp',
    );
  });

  test('does not double the version prefix for a sandbox-injected base', () => {
    expect(acpEndpointForSession(auth({ api_base: 'https://tunnel.test/v1' }), 'p', 's')).toBe(
      'https://tunnel.test/v1/projects/p/sessions/s/acp',
    );
  });
});

describe('acpSessionTargetFromSession', () => {
  test('reads the harness-native identity off the Kortix session row', () => {
    expect(acpSessionTargetFromSession(session())).toEqual({
      acpServerId: 'sess-1',
      acpSessionId: 'ses_native_1',
      runtimeHarness: 'opencode',
      nativeAgent: null,
    });
  });

  test('falls back to the durable session id when acp_server_id is absent', () => {
    const target = acpSessionTargetFromSession(session({ acp_server_id: null }));
    expect(target.acpServerId).toBe('sess-1');
  });

  test('reports a null acp_session_id so the controller issues session/new', () => {
    const target = acpSessionTargetFromSession(session({ acp_session_id: null }));
    expect(target.acpSessionId).toBeNull();
  });

  test('does not invent a harness when the row has none', () => {
    const target = acpSessionTargetFromSession(session({ runtime_harness: null }));
    expect(target.runtimeHarness).toBeUndefined();
  });
});

describe('projectEnvelopes', () => {
  test('folds stored envelopes into renderable messages without a live sandbox', () => {
    const messages = projectEnvelopes('ses_native_1', [
      {
        ordinal: 25097,
        envelope: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_native_1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg_1',
              content: { type: 'text', text: 'hello from postgres' },
            },
          },
        },
      },
    ]);
    const text = messages.flatMap((m) => m.parts).map((p) => (p as { text?: string }).text ?? '');
    expect(text.join('')).toContain('hello from postgres');
  });

  test('assigns the folded message the assistant role', () => {
    const messages = projectEnvelopes('ses_native_1', [
      {
        ordinal: 1,
        envelope: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_native_1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg_1',
              content: { type: 'text', text: 'reply' },
            },
          },
        },
      },
    ]);
    expect(messages[0]!.info.role).toBe('assistant');
  });

  test('ignores an envelope addressed to a different acp session', () => {
    const messages = projectEnvelopes('ses_native_1', [
      {
        ordinal: 1,
        envelope: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_other',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg_1',
              content: { type: 'text', text: 'not mine' },
            },
          },
        },
      },
    ]);
    expect(messages).toEqual([]);
  });

  test('returns no messages for an empty envelope list', () => {
    expect(projectEnvelopes('sess-1', [])).toEqual([]);
  });
});

describe('assistantReplyAfter', () => {
  const user = { info: { id: 'u1', role: 'user' }, parts: [] } as never;
  const assistant = {
    info: { id: 'a1', role: 'assistant' },
    parts: [{ type: 'text', text: 'the answer' }],
  } as never;

  test('returns the newest assistant message that follows the prompt', () => {
    const reply = assistantReplyAfter([user, assistant], 0);
    expect((reply?.parts[0] as { text: string }).text).toBe('the answer');
  });

  test('ignores assistant messages that predate the prompt', () => {
    expect(assistantReplyAfter([assistant, user], 1)).toBeNull();
  });

  test('returns null when the agent produced nothing', () => {
    expect(assistantReplyAfter([user], 1)).toBeNull();
  });
});

describe('sendAcpPromptAndWait', () => {
  function fakeController(script: {
    messagesAfterSend: Array<{ info: unknown; parts: unknown[] }>;
    statusSequence: Array<'busy' | 'idle'>;
  }) {
    let call = 0;
    let sent: { text: string; options: unknown } | null = null;
    const listeners = new Set<() => void>();
    return {
      sent: () => sent,
      controller: {
        getSnapshot() {
          const status = script.statusSequence[Math.min(call, script.statusSequence.length - 1)]!;
          call += 1;
          return {
            ready: true,
            sending: status === 'busy',
            connection: 'open',
            error: null,
            projection: {
              messages: sent ? script.messagesAfterSend : [],
              status: { type: status === 'busy' ? 'working' : 'idle' },
              permissions: [],
              questions: [],
            },
            configOptions: [],
            rewind: null,
            modelNotice: null,
          };
        },
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async connect() {},
        async send(prompt: unknown, options: unknown) {
          sent = { text: String((prompt as Array<{ text: string }>)[0]!.text), options };
          for (const listener of listeners) listener();
        },
      },
    };
  }

  test('sends the prompt as a single text content block', async () => {
    const fake = fakeController({
      messagesAfterSend: [
        { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] },
      ],
      statusSequence: ['idle'],
    });
    await sendAcpPromptAndWait(fake.controller as never, 'ship it', { timeoutMs: 1_000 });
    expect(fake.sent()!.text).toBe('ship it');
  });

  test('forwards the agent selection to the controller', async () => {
    const fake = fakeController({
      messagesAfterSend: [
        { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] },
      ],
      statusSequence: ['idle'],
    });
    await sendAcpPromptAndWait(fake.controller as never, 'hi', {
      agent: 'reviewer',
      timeoutMs: 1_000,
    });
    expect(fake.sent()!.options).toEqual({ agent: 'reviewer' });
  });

  test('returns the assistant reply once the turn goes idle', async () => {
    const fake = fakeController({
      messagesAfterSend: [
        { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] },
      ],
      statusSequence: ['busy', 'busy', 'idle'],
    });
    const reply = await sendAcpPromptAndWait(fake.controller as never, 'go', { timeoutMs: 2_000 });
    expect((reply.parts[0] as { text: string }).text).toBe('done');
  });

  test('rejects when the turn does not settle inside the deadline', async () => {
    const fake = fakeController({
      messagesAfterSend: [{ info: { id: 'a1', role: 'assistant' }, parts: [] }],
      statusSequence: ['busy'],
    });
    await expect(
      sendAcpPromptAndWait(fake.controller as never, 'go', { timeoutMs: 60 }),
    ).rejects.toThrow(/timed out/i);
  });
});
