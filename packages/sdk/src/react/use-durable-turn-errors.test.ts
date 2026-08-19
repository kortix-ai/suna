import { describe, expect, test } from 'bun:test';
import type { SessionTurnHistoryEntry } from '../core/rest/projects-client/sessions';
import { serverTurnErrorRows, shouldRefetchTurnHistory } from './use-durable-turn-errors';

function entry(overrides: Partial<SessionTurnHistoryEntry> = {}): SessionTurnHistoryEntry {
  return {
    turn_token: 'tt',
    message_id: 'msg_user',
    opencode_session_id: 'ses_root',
    state: 'ended',
    end_reason: 'failed',
    started_at: '2026-08-19T00:00:00.000Z',
    ended_at: '2026-08-19T00:00:01.000Z',
    error: {
      name: 'UnknownError',
      message: 'Model not found: kortix/grok-4.6',
      recorded_at: '2026-08-19T00:00:01.000Z',
    },
    ...overrides,
  };
}

describe('serverTurnErrorRows', () => {
  test('keeps a failed turn, keyed by the prompt it answered', () => {
    expect(serverTurnErrorRows([entry()])).toEqual([
      {
        messageId: 'msg_user',
        error: { name: 'UnknownError', message: 'Model not found: kortix/grok-4.6' },
      },
    ]);
  });

  test('drops turns with nothing to render', () => {
    expect(
      serverTurnErrorRows([
        entry({ error: null, end_reason: 'completed' }),
        // No wire id — a trigger, a channel delivery, a `/` command. There is
        // no message in the transcript to hang it on.
        entry({ message_id: null }),
        entry({ message_id: '' }),
        entry({ error: { name: 'X', message: '', recorded_at: 'now' } }),
      ]),
    ).toEqual([]);
  });

  test('carries a synthetic never-ran failure through untouched', () => {
    // The user must never see a turn that silently did nothing.
    expect(
      serverTurnErrorRows([
        entry({
          end_reason: 'abandoned',
          error: {
            name: 'TurnAbandoned',
            message: 'The runtime did not accept this prompt.',
            recorded_at: '2026-08-19T00:00:01.000Z',
          },
        }),
      ])[0],
    ).toEqual({
      messageId: 'msg_user',
      error: { name: 'TurnAbandoned', message: 'The runtime did not accept this prompt.' },
    });
  });

  test('one row per prompt — the newest turn wins a redelivered id', () => {
    // `/turns` is newest first, and a redelivered prompt can settle twice under
    // the same wire id. The freshest ending is the true one.
    const rows = serverTurnErrorRows([
      entry({ turn_token: 'new', error: { name: 'A', message: 'newest', recorded_at: 'z' } }),
      entry({ turn_token: 'old', error: { name: 'B', message: 'oldest', recorded_at: 'a' } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].error.message).toBe('newest');
  });
});

describe('shouldRefetchTurnHistory', () => {
  test('reads the history when a turn ENDS, not while it runs', () => {
    expect(shouldRefetchTurnHistory({ wasWorking: true, isWorking: false })).toBe(true);
    expect(shouldRefetchTurnHistory({ wasWorking: false, isWorking: true })).toBe(false);
    expect(shouldRefetchTurnHistory({ wasWorking: true, isWorking: true })).toBe(false);
    // No transition, no read: this is what keeps the cost at one request per
    // turn end instead of a poll.
    expect(shouldRefetchTurnHistory({ wasWorking: false, isWorking: false })).toBe(false);
  });
});
