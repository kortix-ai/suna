import { describe, expect, test } from 'bun:test';
import { deriveSessionWorking } from './session-working';

const turn = (token: string, startedAt: string, runtime = 'ses_root') => ({
  turn_token: token,
  state: 'active' as const,
  message_id: null,
  runtime_session_id: runtime,
  opencode_session_id: runtime,
  started_at: startedAt,
  accepted_at: null,
});
const prompt = (state: string, reason: string | null = null, sentAt: number | null = null) => ({
  state,
  reason,
  client_sent_at_ms: sentAt,
});

describe('deriveSessionWorking', () => {
  test('a live turn is working, since its start, naming the newest turn', () => {
    expect(
      deriveSessionWorking(
        { turns: [turn('t2', '2026-10-06T10:00:05.000Z'), turn('t1', '2026-10-06T10:00:00.000Z')] },
        [],
        new Map(),
      ),
    ).toEqual({
      state: 'working',
      since: '2026-10-06T10:00:05.000Z',
      turn_token: 't2',
      pending_delivery: false,
    });
  });

  test('a turn the runtime reported ended after it started is no longer working', () => {
    // The ledger closes ~1.7 s after the runtime idles (relay POST). The
    // daemon's `kortix.turn` frame on the stream ends it at once.
    const ends = new Map([['ses_root', Date.parse('2026-10-06T10:00:09.000Z')]]);
    expect(
      deriveSessionWorking(
        {
          turns: [turn('t1', '2026-10-06T10:00:00.000Z')],
          last_ended: { turn_token: 't0', end_reason: 'completed', ended_at: '2026-10-06T09:00:00.000Z' },
        },
        [],
        ends,
      ),
    ).toEqual({ state: 'idle', since: '2026-10-06T10:00:09.000Z', turn_token: null, pending_delivery: false });
  });

  test('a runtime end older than the turn does not end it', () => {
    const ends = new Map([['ses_root', Date.parse('2026-10-06T09:59:00.000Z')]]);
    expect(
      deriveSessionWorking({ turns: [turn('t1', '2026-10-06T10:00:00.000Z')] }, [], ends).state,
    ).toBe('working');
  });

  test('an end of a CHILD session does not end the root turn', () => {
    const ends = new Map([['ses_child', Date.parse('2026-10-06T10:00:09.000Z')]]);
    expect(
      deriveSessionWorking({ turns: [turn('t1', '2026-10-06T10:00:00.000Z')] }, [], ends).state,
    ).toBe('working');
  });

  test('no turn but a live prompt is working with pending delivery', () => {
    for (const row of [prompt('queued'), prompt('delivering'), prompt('waiting', 'turn_running')]) {
      expect(deriveSessionWorking({ turns: [] }, [row], new Map())).toMatchObject({
        state: 'working',
        pending_delivery: true,
        turn_token: null,
      });
    }
  });

  test('a held or failed prompt does not make the session work', () => {
    expect(
      deriveSessionWorking({ turns: [] }, [prompt('waiting', 'held'), prompt('failed')], new Map()).state,
    ).toBe('idle');
  });

  test('pending delivery is dated by the oldest live send', () => {
    expect(
      deriveSessionWorking(
        { turns: [] },
        [prompt('queued', null, Date.parse('2026-10-06T10:00:03.000Z')), prompt('queued', null, Date.parse('2026-10-06T10:00:01.000Z'))],
        new Map(),
      ).since,
    ).toBe('2026-10-06T10:00:01.000Z');
  });

  test('idle is dated by the last ended turn', () => {
    expect(
      deriveSessionWorking(
        { turns: [], last_ended: { turn_token: 't0', end_reason: 'completed', ended_at: '2026-10-06T09:00:00.000Z' } },
        [],
        new Map(),
      ),
    ).toEqual({ state: 'idle', since: '2026-10-06T09:00:00.000Z', turn_token: null, pending_delivery: false });
  });
});
