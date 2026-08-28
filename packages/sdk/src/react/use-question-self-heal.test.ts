import { describe, expect, test } from 'bun:test';

import { hasRunningQuestionTool } from './use-question-self-heal';

function toolPart(tool: string, status: string) {
  return { type: 'tool' as const, tool, callID: 'call_1', state: { status } };
}

describe('hasRunningQuestionTool', () => {
  test('is false with no messages', () => {
    expect(hasRunningQuestionTool(undefined)).toBe(false);
    expect(hasRunningQuestionTool([])).toBe(false);
  });

  test('is false when no assistant message has a question tool', () => {
    const messages = [
      { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text' }] },
      { info: { id: 'm2', role: 'assistant' }, parts: [toolPart('bash', 'running')] },
    ];
    expect(hasRunningQuestionTool(messages)).toBe(false);
  });

  test('is true when a question tool is running', () => {
    const messages = [
      { info: { id: 'm1', role: 'assistant' }, parts: [toolPart('question', 'running')] },
    ];
    expect(hasRunningQuestionTool(messages)).toBe(true);
  });

  test('is true when a question tool is pending', () => {
    const messages = [
      { info: { id: 'm1', role: 'assistant' }, parts: [toolPart('question', 'pending')] },
    ];
    expect(hasRunningQuestionTool(messages)).toBe(true);
  });

  test('is false once the question tool has completed', () => {
    const messages = [
      { info: { id: 'm1', role: 'assistant' }, parts: [toolPart('question', 'completed')] },
    ];
    expect(hasRunningQuestionTool(messages)).toBe(false);
  });

  test('ignores a question tool on a user message', () => {
    const messages = [
      { info: { id: 'm1', role: 'user' }, parts: [toolPart('question', 'running')] },
    ];
    expect(hasRunningQuestionTool(messages)).toBe(false);
  });
});
