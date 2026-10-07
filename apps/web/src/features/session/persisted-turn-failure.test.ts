import { describe, expect, test } from 'bun:test';
import type { Turn } from '@/ui';
import { failureShownByTurn, persistedFailureText } from './persisted-turn-failure';

const BODY = JSON.stringify({
  message: 'All selected ChatGPT connections are cooling down.',
  code: 'provider_pool_rate_limited',
  suggestion: 'Select a granted ChatGPT connection in session settings.',
});

function turn(id: string, error?: Record<string, unknown>): Turn {
  return {
    userMessage: { info: { id }, parts: [] },
    assistantMessages: [{ info: { id: `${id}-a`, ...(error ? { error } : {}) }, parts: [] }],
  } as unknown as Turn;
}

describe('persistedFailureText', () => {
  test("a ledger failure shows the gateway's sentence, not its 429 body", () => {
    expect(persistedFailureText({ message: `429: ${BODY}` })).toBe('All selected ChatGPT connections are cooling down.');
  });

  test('a plain message stays as it is', () => {
    expect(persistedFailureText({ message: 'The run failed.' })).toBe('The run failed.');
    expect(persistedFailureText(null)).toBeUndefined();
  });
});

// A prod Slack session showed one failed turn twice: the turn's own row, and
// the ledger's row, which had no message id to match the turn by.
describe('failureShownByTurn', () => {
  const failed = turn('msg_1', { name: 'UnknownError', code: 'rate_limit', data: { message: `429: ${BODY}` } });

  test('a failure with no message id repeats a turn that shows the same error', () => {
    expect(failureShownByTurn({ message_id: null, error: { message: `429: ${BODY}` } }, [failed])).toBe(true);
  });

  test('a failure with no message id and a different error is its own row', () => {
    expect(failureShownByTurn({ message_id: null, error: { message: 'The run failed.' } }, [failed])).toBe(false);
  });

  test('a failure is matched to its turn by message id', () => {
    expect(failureShownByTurn({ message_id: 'msg_1', error: null }, [turn('msg_1')])).toBe(true);
    expect(failureShownByTurn({ message_id: 'msg_2', error: { message: `429: ${BODY}` } }, [failed])).toBe(false);
  });
});
