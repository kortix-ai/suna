import { describe, expect, test } from 'bun:test';
import {
  projectAcpChatItems,
  projectAcpContext,
  projectAcpPendingPrompts,
  projectAcpTurnState,
  projectAcpTranscript,
  projectAcpUsage,
  type AcpStoredEnvelope,
} from './transcript';

function stored(
  ordinal: number,
  direction: AcpStoredEnvelope['direction'],
  envelope: AcpStoredEnvelope['envelope'],
): AcpStoredEnvelope {
  return { ordinal, direction, envelope };
}

describe('projectAcpUsage', () => {
  test('projects the latest standard ACP context and cost update', () => {
    const usage = projectAcpUsage([
      stored(1, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update', params: { update: {
          sessionUpdate: 'usage_update', used: 53_000, size: 200_000,
          cost: { amount: 0.045, currency: 'USD' },
        } },
      }),
      stored(2, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update', params: { update: {
          sessionUpdate: 'usage_update', used: 61_000, size: 200_000,
        } },
      }),
    ]);

    expect(usage).toEqual({
      used: 61_000,
      size: 200_000,
      percent: 30.5,
      cost: null,
      tokens: null,
      source: 'usage_update',
    });
  });

  test('falls back to unstable prompt response token usage without inventing a context limit', () => {
    const usage = projectAcpUsage([
      stored(1, 'agent_to_client', {
        jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn', usage: {
          totalTokens: 120, inputTokens: 80, outputTokens: 40,
          thoughtTokens: 10, cachedReadTokens: 5, cachedWriteTokens: 2,
        } },
      }),
    ]);

    expect(usage).toEqual({
      used: null,
      size: null,
      percent: null,
      cost: null,
      tokens: {
        total: 120, input: 80, output: 40, thought: 10,
        cachedRead: 5, cachedWrite: 2,
      },
      source: 'prompt_response',
    });
  });
});

describe('projectAcpTurnState', () => {
  test('recovers an in-flight prompt after reload and clears it on response', () => {
    const prompt = stored(1, 'client_to_agent', {
      jsonrpc: '2.0', id: 41, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'go' }] },
    });
    expect(projectAcpTurnState([prompt])).toEqual({ busy: true, pendingPromptIds: [41] });
    expect(projectAcpTurnState([
      prompt,
      stored(2, 'agent_to_client', { jsonrpc: '2.0', id: 41, result: { stopReason: 'end_turn' } }),
    ])).toEqual({ busy: false, pendingPromptIds: [] });
  });

  test('does not treat a local optimistic transcript row as a persisted pending request', () => {
    expect(projectAcpTurnState([
      stored(1, 'client_to_agent', {
        jsonrpc: '2.0', id: 'local-1', method: 'session/prompt', params: { prompt: [] },
      }),
    ]).busy).toBe(false);
  });
});

describe('projectAcpContext', () => {
  test('returns message/thought context and usage while excluding tools', () => {
    const context = projectAcpContext([
      stored(1, 'client_to_agent', {
        jsonrpc: '2.0', id: 1, method: 'session/prompt',
        params: { prompt: [{ type: 'text', text: 'hello' }] },
      }),
      stored(2, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update', params: { update: {
          sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Shell',
        } },
      }),
      stored(3, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update', params: { update: {
          sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' },
        } },
      }),
      stored(4, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update', params: { update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' },
        } },
      }),
      stored(5, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update', params: { update: {
          sessionUpdate: 'usage_update', used: 20, size: 100,
        } },
      }),
    ]);

    expect(context.messages).toEqual([
      { id: 'prompt-1', role: 'user', text: 'hello' },
      { id: 'thought-3', role: 'thought', text: 'thinking' },
      { id: 'assistant-4', role: 'assistant', text: 'done' },
    ]);
    expect(context.usage?.percent).toBe(20);
  });
});

describe('projectAcpTranscript', () => {
  test('retains attachment metadata without serializing base64 payloads', () => {
    const messages = projectAcpTranscript([
      stored(1, 'client_to_agent', {
        jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [
          { type: 'text', text: 'inspect' },
          { type: 'resource_link', uri: 'https://example.com/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' },
          { type: 'image', data: 'secret-base64-payload', mimeType: 'image/png' },
        ] },
      }),
    ]);

    expect(messages[0]?.files).toEqual([
      { filename: 'a.pdf', mime: 'application/pdf' },
      { filename: null, mime: 'image/png' },
    ]);
    expect(JSON.stringify(messages)).not.toContain('secret-base64-payload');
  });

  test('projects prompts, streamed replies, thoughts, and tools without harness types', () => {
    const messages = projectAcpTranscript([
      { ordinal: 1, direction: 'client_to_agent', envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Fix it' }] } } },
      { ordinal: 2, direction: 'agent_to_client', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } } } },
      { ordinal: 3, direction: 'agent_to_client', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private' } } } } },
      { ordinal: 4, direction: 'agent_to_client', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'shell', status: 'pending' } } } },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'Fix it' }),
      expect.objectContaining({
        role: 'assistant',
        text: 'Done',
        reasoning_omitted: true,
        tools: [{ tool: 'shell', status: 'pending' }],
      }),
    ]);
  });
});

describe('projectAcpPendingPrompts', () => {
  test('returns unresolved ACP permission requests and hides answered ones', () => {
    const pending = projectAcpPendingPrompts([
      { ordinal: 1, direction: 'agent_to_client', envelope: { jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { permission: 'bash', patterns: ['rm -rf *'], options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }] } } },
      { ordinal: 2, direction: 'agent_to_client', envelope: { jsonrpc: '2.0', id: 'perm-2', method: 'session/request_permission', params: { permission: 'edit', options: [{ optionId: 'allow_once' }] } } },
      { ordinal: 3, direction: 'client_to_agent', envelope: { jsonrpc: '2.0', id: 'perm-2', result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } } },
    ]);

    expect(pending.permissions).toEqual([
      expect.objectContaining({
        id: 'perm-1',
        method: 'session/request_permission',
        permission: 'bash',
        patterns: ['rm -rf *'],
        options: [expect.objectContaining({ optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' })],
      }),
    ]);
    expect(pending.questions).toEqual([]);
  });

  test('projects ACP elicitation schema fields as questions', () => {
    const pending = projectAcpPendingPrompts([
      {
        ordinal: 1,
        direction: 'agent_to_client',
        envelope: {
          jsonrpc: '2.0',
          id: 9,
          method: 'elicitation/create',
          params: {
            message: 'Choose an environment',
            requestedSchema: {
              type: 'object',
              properties: {
                environment: {
                  title: 'Environment',
                  enum: ['staging', 'production'],
                },
              },
            },
          },
        },
      },
    ]);

    expect(pending.questions).toEqual([
      expect.objectContaining({
        id: 9,
        method: 'elicitation/create',
        questions: [
          expect.objectContaining({
            key: 'environment',
            question: 'Environment',
            header: 'Choose an environment',
            options: [
              { label: 'staging', value: 'staging' },
              { label: 'production', value: 'production' },
            ],
          }),
        ],
      }),
    ]);
  });
});

describe('projectAcpChatItems', () => {
  test('preserves user and assistant ACP image/resource attachments', () => {
    const items = projectAcpChatItems([
      stored(1, 'client_to_agent', {
        jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [
          { type: 'text', text: 'inspect these' },
          { type: 'resource_link', uri: 'https://example.com/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ] },
      }),
      stored(2, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update', params: { update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'resource', resource: { uri: 'file:///workspace/out.txt', name: 'out.txt', mimeType: 'text/plain' } },
        } },
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'message', role: 'user', text: 'inspect these',
        attachments: [
          { kind: 'resource', name: 'a.pdf', uri: 'https://example.com/a.pdf', mimeType: 'application/pdf' },
          { kind: 'image', name: null, uri: null, mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
      }),
      expect.objectContaining({
        kind: 'message', role: 'assistant', text: '',
        attachments: [
          { kind: 'resource', name: 'out.txt', uri: 'file:///workspace/out.txt', mimeType: 'text/plain' },
        ],
      }),
    ]);
  });

  test('merges tool call updates into one canonical tool item', () => {
    const items = projectAcpChatItems([
      { ordinal: 1, direction: 'agent_to_client', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read file', kind: 'read', status: 'pending', rawInput: { path: 'a.ts' } } } } },
      { ordinal: 2, direction: 'agent_to_client', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: 'ok' } } } },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'tool', id: 'call-1', title: 'Read file', toolKind: 'read', status: 'completed', rawInput: { path: 'a.ts' }, rawOutput: 'ok' }),
    ]);
  });

  test('renders ACP elicitation as a question item, not raw JSON', () => {
    const items = projectAcpChatItems([
      {
        ordinal: 1,
        direction: 'agent_to_client',
        envelope: {
          jsonrpc: '2.0',
          id: 'q1',
          method: 'elicitation/create',
          params: {
            message: 'Choose an environment',
            requestedSchema: {
              type: 'object',
              properties: {
                environment: { title: 'Environment', enum: ['staging'] },
              },
            },
          },
        },
      },
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'question',
        id: 'q1',
        questions: [expect.objectContaining({ key: 'environment', question: 'Environment' })],
      }),
    ]);
  });
});
