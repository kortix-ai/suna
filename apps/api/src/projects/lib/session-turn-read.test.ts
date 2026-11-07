/**
 * Characterization: the single-session turn read and the batched read answer
 * the same question from the same lifecycle authority, so for one session they
 * must agree on `turns` and `last_ended`. The database is a fake that serves
 * rows by the shape of the selected columns, so what is pinned is the
 * projection, not the SQL.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionTurnStatus } from '@kortix/api-contract';

interface FakeRows {
  boxes: Array<Record<string, unknown>>;
  ledger: Array<Record<string, unknown>>;
  ended: Array<Record<string, unknown>>;
  recent: Array<Record<string, unknown>>;
}
let rows: FakeRows = { boxes: [], ledger: [], ended: [], recent: [] };
const recovered: string[] = [];

function rowsFor(fields: Record<string, unknown>): Array<Record<string, unknown>> {
  if ('acceptedAt' in fields) return rows.ledger;
  if ('endReason' in fields && 'turnToken' in fields) return rows.ended;
  if ('endReason' in fields) return rows.recent;
  return rows.boxes;
}
function chain(result: Array<Record<string, unknown>>) {
  const builder: Record<string, unknown> = {
    where: () => builder,
    orderBy: () => builder,
    limit: (n: number) => { result = result.slice(0, n); return builder; },
    then: (resolve: (value: unknown) => unknown) => resolve(result),
  };
  return builder;
}
mock.module('../../shared/db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => ({ from: () => chain(rowsFor(fields)) }),
    selectDistinctOn: (_on: unknown, fields: Record<string, unknown>) => ({ from: () => chain(rowsFor(fields)) }),
  },
}));
mock.module('../session-lifecycle/inbox-turn-recovery', () => ({
  scheduleSessionTurnRecovery: (box: { sessionId: string }) => { recovered.push(box.sessionId); },
}));

const { readSessionTurnState, readSessionTurnStates } = await import('./session-turn-read');

const SESSION = 'session-1';
const startedAt = new Date('2026-11-01T10:00:00Z');
const liveBox = {
  sessionId: SESSION,
  status: 'active',
  sandboxId: 'sandbox-1',
  externalId: 'ext-1',
  provider: 'daytona',
  metadata: {
    activeTurns: {
      'token-live': { token: 'token-live', state: 'delivering', runtimeSessionId: null, messageId: null, startedAtMs: startedAt.getTime() },
    },
  },
};
const ledgerRow = {
  turnToken: 'token-live', sessionId: SESSION, messageId: 'msg-live',
  runtimeSessionId: 'runtime-1', startedAt, acceptedAt: new Date('2026-11-01T10:00:05Z'),
};
const endedRow = {
  sessionId: SESSION, turnToken: 'token-old', messageId: 'msg-old', endReason: 'idle',
  endError: null, endedAt: new Date('2026-11-01T09:00:00Z'),
};

async function both() {
  const single = await readSessionTurnState(SESSION);
  const batched = (await readSessionTurnStates([SESSION])).get(SESSION);
  return { single, batched };
}

beforeEach(() => {
  rows = { boxes: [], ledger: [], ended: [], recent: [] };
  recovered.length = 0;
});

describe('single and batched turn reads', () => {
  test('a live turn and an ended turn project identically', async () => {
    rows = { boxes: [liveBox], ledger: [ledgerRow], ended: [endedRow], recent: [] };
    const { single, batched } = await both();
    const expected: SessionTurnStatus = {
      turns: [{
        turn_token: 'token-live', state: 'delivering', message_id: 'msg-live', runtime_session_id: 'runtime-1',
        started_at: '2026-11-01T10:00:00.000Z', accepted_at: '2026-11-01T10:00:05.000Z',
      }],
      last_ended: { turn_token: 'token-old', message_id: 'msg-old', end_reason: 'idle', ended_at: '2026-11-01T09:00:00.000Z' },
    };
    expect(single).toEqual(expected);
    expect(batched).toEqual(expected);
    expect(recovered).toEqual([SESSION, SESSION]);
  });

  test('a session with no box reports no live turn and its last ended turn', async () => {
    rows = { boxes: [], ledger: [], ended: [{ ...endedRow, endError: { name: 'UserStop' } }], recent: [] };
    const { single, batched } = await both();
    const expected = { turns: [], last_ended: { turn_token: 'token-old', message_id: 'msg-old', end_reason: 'idle', ended_at: '2026-11-01T09:00:00.000Z' } };
    expect(single).toEqual(expected);
    expect(batched).toEqual(expected);
    expect(recovered).toEqual([]);
  });

  test('a stopped box holds no live turn and a session with no rows is empty', async () => {
    rows = { boxes: [{ ...liveBox, status: 'stopped' }], ledger: [ledgerRow], ended: [], recent: [] };
    expect(await both()).toEqual({ single: { turns: [] }, batched: { turns: [] } });
    expect(recovered).toEqual([]);
    rows = { boxes: [], ledger: [], ended: [], recent: [] };
    expect(await both()).toEqual({ single: { turns: [] }, batched: { turns: [] } });
  });

  test('an unexplained or named failure is listed by the single read only', async () => {
    rows = {
      boxes: [], ledger: [], ended: [],
      recent: [{ messageId: 'msg-dead', endReason: 'runtime_gone', endError: null, endedAt: new Date('2026-11-01T08:00:00Z') }],
    };
    const { single, batched } = await both();
    expect(single).toEqual({ turns: [], recent_failures: [{ message_id: 'msg-dead', ended_at: '2026-11-01T08:00:00.000Z', error: null }] });
    expect(batched).toEqual({ turns: [] });
  });
});
