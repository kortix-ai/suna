import { expect, test } from 'bun:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { completedToolCalls, hasIncompleteToolHistory } from './tool-replay.ts';

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

const call = (id: string, name = 'bash') => fauxAssistantMessage([
  fauxToolCall(name, { command: 'read' }, { id }),
], { stopReason: 'toolUse' });
const result = (id: string, name = 'bash'): AgentMessage => ({
  role: 'toolResult', toolCallId: id, toolName: name,
  content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 1,
});

test('complete tool history survives interruption, including repeated provider call IDs in separate rounds', () => {
  expect(hasIncompleteToolHistory([])).toBe(false);
  expect(hasIncompleteToolHistory([call('one'), result('one'), call('one'), result('one')])).toBe(false);
  expect(hasIncompleteToolHistory([call('one'), result('one'), { role: 'user', content: 'Compact.', timestamp: 2 }, fauxAssistantMessage('summary')])).toBe(false);
});

test('unfinished or mismatched tool history requires recovery before the next provider request', () => {
  expect(hasIncompleteToolHistory([call('one')])).toBe(true);
  expect(hasIncompleteToolHistory([call('one'), result('two')])).toBe(true);
  expect(hasIncompleteToolHistory([call('one'), result('one', 'read')])).toBe(true);
  expect(hasIncompleteToolHistory([result('one')])).toBe(true);
});

test('a later message cannot hide an unfinished tool batch', () => {
  expect(hasIncompleteToolHistory([call('one'), fauxAssistantMessage('interrupted')])).toBe(true);
  expect(hasIncompleteToolHistory([call('one'), { role: 'user', content: 'Next.', timestamp: 2 }])).toBe(true);
  expect(hasIncompleteToolHistory([call('one'), call('two'), result('two')])).toBe(true);
});

test('all parallel tool results must exist exactly once', () => {
  const batch = fauxAssistantMessage([fauxToolCall('bash', {}, { id: 'one' }), fauxToolCall('read', {}, { id: 'two' })], { stopReason: 'toolUse' });
  expect(hasIncompleteToolHistory([batch, result('two', 'read'), result('one')])).toBe(false);
  expect(hasIncompleteToolHistory([batch, result('one')])).toBe(true);
  expect(hasIncompleteToolHistory([batch, result('one'), result('one')])).toBe(true);
});
