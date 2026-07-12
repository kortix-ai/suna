import { describe, expect, test } from 'bun:test';

import { projectAcpChatItems as projectAcpEnvelopes } from '@kortix/sdk';

describe('ACP-native chat projection', () => {
  test('keeps user prompts, assistant chunks, thoughts, tools, and permissions protocol-native', () => {
    const rows: any[] = [
      { ordinal: 1, direction: 'client_to_agent', streamEventId: null, envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Review this' }] } } },
      { ordinal: 2, direction: 'agent_to_client', streamEventId: 1, envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking' } } } } },
      { ordinal: 3, direction: 'agent_to_client', streamEventId: 2, envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looks ' } } } } },
      { ordinal: 4, direction: 'agent_to_client', streamEventId: 3, envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'good' } } } } },
      { ordinal: 5, direction: 'agent_to_client', streamEventId: 4, envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'Read file' } } } },
      { ordinal: 6, direction: 'agent_to_client', streamEventId: 5, envelope: { jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { options: [{ optionId: 'allow', name: 'Allow' }] } } },
    ];

    expect(projectAcpEnvelopes(rows)).toMatchObject([
      { kind: 'message', role: 'user', text: 'Review this' },
      { kind: 'message', role: 'thought', text: 'Checking' },
      { kind: 'message', role: 'assistant', text: 'Looks good' },
      { kind: 'tool', title: 'Read file' },
      { kind: 'permission', id: 9, method: 'session/request_permission' },
    ]);
  });
});
