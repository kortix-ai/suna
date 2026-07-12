import { describe, expect, test } from 'bun:test';
import { projectAcpChatItems, projectAcpPendingPrompts, projectAcpTranscript } from './transcript';

describe('projectAcpTranscript', () => {
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
