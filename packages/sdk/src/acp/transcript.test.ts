import { describe, expect, test } from 'bun:test';
import { projectAcpTranscript } from './transcript';

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
