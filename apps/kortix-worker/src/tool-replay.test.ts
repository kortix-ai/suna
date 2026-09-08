import { expect, test } from 'bun:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { completedToolCalls } from './tool-replay.ts';

test('restored loop history includes only completed calls after the last user input', () => {
  const call = (command: string) => fauxAssistantMessage([
    fauxToolCall('bash', { command }, { id: 'reused' }),
  ], { stopReason: 'toolUse' });
  const result: AgentMessage = {
    role: 'toolResult', toolCallId: 'reused', toolName: 'bash',
    content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 1,
  };
  const user: AgentMessage = { role: 'user', content: 'Next.', timestamp: 2 };
  expect(completedToolCalls([call('old'), result, user, result])).toEqual([]);
  expect(completedToolCalls([
    call('old'), result, user, call('current'), result, call('current'), result,
  ])).toEqual([
    { name: 'bash', input: { command: 'current' } },
    { name: 'bash', input: { command: 'current' } },
  ]);
});
