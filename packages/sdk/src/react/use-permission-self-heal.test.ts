import { describe, expect, test } from 'bun:test';

import {
  findPermissionBlockedCandidate,
  hasActiveNonQuestionTool,
} from './use-permission-self-heal';

const NOW = 1_000_000;

function toolPart(
  tool: string,
  status: string,
  extra: { input?: Record<string, unknown>; start?: number } = {},
) {
  return {
    type: 'tool' as const,
    tool,
    callID: 'call_1',
    state: {
      status,
      input: extra.input,
      time: extra.start !== undefined ? { start: extra.start } : undefined,
    },
  };
}

function assistant(parts: unknown[]) {
  return { info: { id: 'm1', role: 'assistant' }, parts } as never;
}

describe('hasActiveNonQuestionTool', () => {
  test('is false with no messages', () => {
    expect(hasActiveNonQuestionTool(undefined)).toBe(false);
    expect(hasActiveNonQuestionTool([])).toBe(false);
  });

  test('is true for a running bash tool', () => {
    expect(hasActiveNonQuestionTool([assistant([toolPart('bash', 'running')])])).toBe(true);
  });

  test('ignores the question tool (it has its own self-heal)', () => {
    expect(hasActiveNonQuestionTool([assistant([toolPart('question', 'running')])])).toBe(false);
  });

  test('is false once tools settle', () => {
    expect(hasActiveNonQuestionTool([assistant([toolPart('bash', 'completed')])])).toBe(false);
  });

  test('ignores tool parts on user messages', () => {
    const messages = [
      { info: { id: 'm1', role: 'user' }, parts: [toolPart('bash', 'running')] },
    ] as never[];
    expect(hasActiveNonQuestionTool(messages)).toBe(false);
  });
});

describe('findPermissionBlockedCandidate', () => {
  test('empty input pending is the stale "session ended" shape — not a candidate', () => {
    const messages = [assistant([toolPart('bash', 'pending', { input: {} })])];
    expect(findPermissionBlockedCandidate(messages, NOW)).toEqual({
      pendingWithInput: false,
      staleRunning: false,
    });
  });

  test('pending with input is the fast-poll candidate', () => {
    const messages = [assistant([toolPart('bash', 'pending', { input: { command: 'ls' } })])];
    expect(findPermissionBlockedCandidate(messages, NOW).pendingWithInput).toBe(true);
  });

  test('recently-started running tool is not a candidate', () => {
    const messages = [assistant([toolPart('bash', 'running', { start: NOW - 2_000 })])];
    expect(findPermissionBlockedCandidate(messages, NOW)).toEqual({
      pendingWithInput: false,
      staleRunning: false,
    });
  });

  test('long-running tool becomes the slow-poll candidate', () => {
    const messages = [assistant([toolPart('bash', 'running', { start: NOW - 60_000 })])];
    expect(findPermissionBlockedCandidate(messages, NOW).staleRunning).toBe(true);
  });

  test('question tool never qualifies', () => {
    const messages = [
      assistant([
        toolPart('question', 'pending', { input: { question: 'hm' } }),
        toolPart('question', 'running', { start: NOW - 60_000 }),
      ]),
    ];
    expect(findPermissionBlockedCandidate(messages, NOW)).toEqual({
      pendingWithInput: false,
      staleRunning: false,
    });
  });
});
