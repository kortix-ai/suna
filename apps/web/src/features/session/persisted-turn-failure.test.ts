import { describe, expect, test } from 'bun:test';
import type { Turn } from '@/ui';
import { failureShownByTurn, failureSupersededByTurn, persistedFailureText } from './persisted-turn-failure';

const BODY = JSON.stringify({
  message: 'All selected ChatGPT connections are cooling down.',
  code: 'provider_pool_rate_limited',
  suggestion: 'Select a granted ChatGPT connection in session settings.',
});

function turn(id: string, error?: Record<string, unknown>, created?: number): Turn {
  return {
    userMessage: { info: { id, ...(created === undefined ? {} : { time: { created } }) }, parts: [] },
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

// Editing a failed message rewinds it and sends a new one. The ledger still
// lists the old message's failure, and its turn left the transcript, so the
// failure drew under the new, running turn and never went away.
describe('failureSupersededByTurn', () => {
  const ENDED = '2026-10-07T12:00:00.000Z';
  const endedMs = Date.parse(ENDED);

  test('a turn sent after the failure ended supersedes it', () => {
    const failure = { message_id: 'msg_rewound', ended_at: ENDED, error: null };
    expect(failureSupersededByTurn(failure, [turn('msg_edited', undefined, endedMs + 5_000)])).toBe(true);
  });

  test('a turn sent before the failure ended does not supersede it', () => {
    const failure = { message_id: 'msg_admission', ended_at: ENDED, error: null };
    expect(failureSupersededByTurn(failure, [turn('msg_old', undefined, endedMs - 5_000)])).toBe(false);
    expect(failureSupersededByTurn(failure, [])).toBe(false);
  });

  test('an unknown end time or send time supersedes nothing', () => {
    expect(failureSupersededByTurn({ message_id: 'm', ended_at: null, error: null }, [turn('n', undefined, endedMs)])).toBe(false);
    expect(failureSupersededByTurn({ message_id: 'm', ended_at: ENDED, error: null }, [turn('n')])).toBe(false);
  });
});
