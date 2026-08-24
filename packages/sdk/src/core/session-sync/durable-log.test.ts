import { describe, expect, test } from 'bun:test';

import {
  DURABLE_HISTORY_PAGE_SIZE,
  durableSeqOf,
  isDurableLogUnsupported,
  readSessionDurableHistory,
  type DurableLogClient,
} from './durable-log';

function event(seq: number, type = 'session.next.text.delta') {
  return { id: `evt-${seq}`, type, durable: { aggregateID: 'agg', seq, version: 1 } };
}

function clientReturning(pages: Array<{ data: unknown[]; hasMore: boolean }>): {
  client: DurableLogClient;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  let index = 0;
  return {
    calls,
    client: {
      v2: {
        session: {
          history: async (request) => {
            calls.push(request);
            return { data: pages[index++] };
          },
        },
      },
    },
  };
}

describe('durableSeqOf', () => {
  test('reads the aggregate sequence off a durable event', () => {
    expect(durableSeqOf(event(42))).toBe(42);
  });

  test('a non-durable frame has no sequence — it can never advance the cursor', () => {
    expect(durableSeqOf({ id: 'x', type: 'session.next.text.delta' })).toBeNull();
    expect(durableSeqOf({ durable: {} })).toBeNull();
    expect(durableSeqOf(null)).toBeNull();
    expect(durableSeqOf({ durable: { seq: 'nope' } })).toBeNull();
  });
});

describe('readSessionDurableHistory', () => {
  test('asks for events AFTER the cursor and reports the new one', async () => {
    const { client, calls } = clientReturning([
      { data: [event(7), event(8), event(9)], hasMore: true },
    ]);

    const page = await readSessionDurableHistory(client, 'ses_1', { after: 6 });

    expect(calls).toEqual([{ sessionID: 'ses_1', limit: DURABLE_HISTORY_PAGE_SIZE, after: 6 }]);
    expect(page.events.map(durableSeqOf)).toEqual([7, 8, 9]);
    expect(page.hasMore).toBe(true);
    expect(page.lastSeq).toBe(9);
  });

  test('omits `after` on a first read so the log starts at its beginning', async () => {
    const { client, calls } = clientReturning([{ data: [], hasMore: false }]);

    const page = await readSessionDurableHistory(client, 'ses_1', {});

    expect(calls).toEqual([{ sessionID: 'ses_1', limit: DURABLE_HISTORY_PAGE_SIZE }]);
    expect(page.lastSeq).toBeNull();
  });

  /**
   * The cursor must only ever move FORWARD. A page whose events arrive out of
   * order, or which mixes in a frame carrying no sequence, must not rewind it —
   * rewinding means replaying events we already applied.
   */
  test('the cursor takes the highest sequence in the page, not the last one', async () => {
    const { client } = clientReturning([
      { data: [event(11), { id: 'no-seq', type: 'x' }, event(10)], hasMore: false },
    ]);

    const page = await readSessionDurableHistory(client, 'ses_1', { after: 9 });

    expect(page.lastSeq).toBe(11);
  });

  test('never rewinds below the cursor it was given', async () => {
    const { client } = clientReturning([{ data: [event(3)], hasMore: false }]);

    const page = await readSessionDurableHistory(client, 'ses_1', { after: 100 });

    expect(page.lastSeq).toBe(100);
  });
});

/**
 * Self-hosted installs run older sandbox images. A 404 from the durable routes
 * is a CAPABILITY answer — "this runtime predates the log" — and must fall back
 * to the message read, never surface as a failure.
 */
describe('isDurableLogUnsupported', () => {
  test('404 means the runtime predates the durable log', () => {
    expect(isDurableLogUnsupported({ status: 404 })).toBe(true);
    expect(isDurableLogUnsupported({ statusCode: 404 })).toBe(true);
  });

  test('every other failure is a real failure and must not be swallowed', () => {
    expect(isDurableLogUnsupported({ status: 503 })).toBe(false);
    expect(isDurableLogUnsupported(new Error('network down'))).toBe(false);
    expect(isDurableLogUnsupported(null)).toBe(false);
  });
});
