import { describe, expect, test } from 'bun:test';

import type { MessageWithParts } from '@/lib/opencode/types';
import {
  QUESTION_POLL_INTERVAL_MS,
  QUESTION_POLL_MAX_INTERVAL_MS,
  hasRunningQuestionTool,
  nextQuestionPollDelay,
  shouldPollQuestions,
} from './question-poll';

function assistant(id: string, parts: Array<Record<string, unknown>>): MessageWithParts {
  return {
    info: { id, role: 'assistant', sessionID: 's1', time: { created: 1 } } as MessageWithParts['info'],
    parts: parts as unknown as MessageWithParts['parts'],
  };
}

function user(id: string): MessageWithParts {
  return {
    info: { id, role: 'user', sessionID: 's1', time: { created: 1 } } as MessageWithParts['info'],
    parts: [],
  };
}

function questionTool(status: string) {
  return { type: 'tool', id: `t-${status}`, tool: 'question', callID: 'c1', state: { status } };
}

describe('constants', () => {
  test('poll interval is 3 s and backoff is capped at 30 s', () => {
    expect(QUESTION_POLL_INTERVAL_MS).toBe(3000);
    expect(QUESTION_POLL_MAX_INTERVAL_MS).toBe(30_000);
  });
});

describe('shouldPollQuestions', () => {
  test('polls only when a question tool runs, nothing is pending, and a sandbox exists', () => {
    expect(shouldPollQuestions({ hasRunningQuestionTool: true, pendingCount: 0, hasSandboxUrl: true })).toBe(true);
  });

  test('does not poll without a running question tool', () => {
    expect(shouldPollQuestions({ hasRunningQuestionTool: false, pendingCount: 0, hasSandboxUrl: true })).toBe(false);
  });

  test('does not poll when a question is already pending', () => {
    expect(shouldPollQuestions({ hasRunningQuestionTool: true, pendingCount: 1, hasSandboxUrl: true })).toBe(false);
  });

  test('does not poll without a sandbox url', () => {
    expect(shouldPollQuestions({ hasRunningQuestionTool: true, pendingCount: 0, hasSandboxUrl: false })).toBe(false);
  });
});

describe('nextQuestionPollDelay', () => {
  test('polls every 3 s while requests succeed', () => {
    expect(nextQuestionPollDelay(200, 0)).toBe(3000);
  });

  test('stops on 401 and 403 immediately', () => {
    expect(nextQuestionPollDelay(401, 1)).toBeNull();
    expect(nextQuestionPollDelay(403, 1)).toBeNull();
  });

  test('backs off on transient failures: 6 s, 12 s, 24 s, then 30 s', () => {
    expect(nextQuestionPollDelay(500, 1)).toBe(6000);
    expect(nextQuestionPollDelay(null, 2)).toBe(12_000);
    expect(nextQuestionPollDelay(502, 3)).toBe(24_000);
    expect(nextQuestionPollDelay(null, 4)).toBe(30_000);
  });

  test('never stops for good on transient failures', () => {
    expect(nextQuestionPollDelay(null, 50)).toBe(30_000);
    expect(nextQuestionPollDelay(503, 5000)).toBe(30_000);
  });
});

describe('hasRunningQuestionTool', () => {
  test('detects a running or pending question tool in the newest assistant message', () => {
    expect(hasRunningQuestionTool([user('u1'), assistant('a1', [questionTool('running')])])).toBe(true);
    expect(hasRunningQuestionTool([user('u1'), assistant('a1', [questionTool('pending')])])).toBe(true);
  });

  test('ignores completed question tools and other tools', () => {
    expect(hasRunningQuestionTool([assistant('a1', [questionTool('completed')])])).toBe(false);
    expect(
      hasRunningQuestionTool([
        assistant('a1', [{ type: 'tool', id: 't', tool: 'bash', callID: 'c', state: { status: 'running' } }]),
      ]),
    ).toBe(false);
  });

  test('looks only at the newest assistant message', () => {
    const messages = [
      assistant('a1', [questionTool('running')]),
      user('u2'),
      assistant('a2', [{ type: 'text', id: 'x', text: 'hi' }]),
    ];
    expect(hasRunningQuestionTool(messages)).toBe(false);
  });

  test('uses the newest assistant message even when a user message follows it', () => {
    expect(hasRunningQuestionTool([assistant('a1', [questionTool('running')]), user('u2')])).toBe(true);
  });

  test('returns false for an empty transcript', () => {
    expect(hasRunningQuestionTool([])).toBe(false);
  });
});
