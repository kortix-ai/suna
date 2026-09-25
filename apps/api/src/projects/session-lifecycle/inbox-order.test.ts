import { describe, expect, test } from 'bun:test';
import { compareInboxSendOrder, underPlacementKeepsSendOrder } from './inbox-order';
import type { SessionLifecycleCommandRow } from './store';

function row(
  commandId: string,
  clientSentAtMs: number | undefined,
  createdAt: string,
  wireMessageId = '',
  placement?: 'transcript' | 'composer',
): SessionLifecycleCommandRow {
  return {
    commandId,
    payload: {
      ...(clientSentAtMs === undefined ? {} : { clientSentAtMs }),
      ...(wireMessageId ? { wireMessageId } : {}),
      ...(placement ? { placement } : {}),
    },
    createdAt: new Date(createdAt),
  } as SessionLifecycleCommandRow;
}

describe('compareInboxSendOrder', () => {
  test('uses the Enter instant before the racing database insert instant', () => {
    const first = row('00000000-0000-0000-0000-000000000001', 1_000, '2026-08-02T00:00:00Z');
    const second = row('00000000-0000-0000-0000-000000000002', 1_001, '2026-08-01T00:00:00Z');

    expect([second, first].sort(compareInboxSendOrder)).toEqual([first, second]);
  });

  test('uses the monotonic wire id for equal-millisecond sends', () => {
    const first = row(
      '00000000-0000-0000-0000-000000000002',
      1_000,
      '2026-08-02T00:00:00Z',
      'msg_000000000001',
    );
    const second = row(
      '00000000-0000-0000-0000-000000000001',
      1_000,
      '2026-08-01T00:00:00Z',
      'msg_000000000002',
    );

    expect(compareInboxSendOrder(first, second)).toBeLessThan(0);
    expect(compareInboxSendOrder(second, first)).toBeGreaterThan(0);
  });

  test('falls back to creation time for older producers', () => {
    const first = row('00000000-0000-0000-0000-000000000001', undefined, '2026-08-01T00:00:00Z');
    const second = row('00000000-0000-0000-0000-000000000002', undefined, '2026-08-02T00:00:00Z');

    expect(compareInboxSendOrder(first, second)).toBeLessThan(0);
  });

  test('Quick Queue runs before an older Queue List entry', () => {
    const queueList = row('00000000-0000-0000-0000-000000000001', 1_000, '2026-08-01T00:00:00Z', '', 'composer');
    const quickQueue = row('00000000-0000-0000-0000-000000000002', 2_000, '2026-08-01T00:00:01Z', '', 'transcript');

    expect([queueList, quickQueue].sort(compareInboxSendOrder)).toEqual([quickQueue, queueList]);
  });

  test('a row with no placement keeps send order ahead of Queue List only', () => {
    // A first prompt or an automation row has no placement. A later Quick
    // Queue entry must not overtake it.
    const first = row('00000000-0000-0000-0000-000000000001', 1_000, '2026-08-01T00:00:00Z');
    const quickQueue = row('00000000-0000-0000-0000-000000000002', 2_000, '2026-08-01T00:00:01Z', '', 'transcript');
    const queueList = row('00000000-0000-0000-0000-000000000003', 500, '2026-08-01T00:00:00Z', '', 'composer');

    expect([queueList, quickQueue, first].sort(compareInboxSendOrder)).toEqual([first, quickQueue, queueList]);
  });
});

// The drain's send-order gate on under-placement (queued-continue.ts). A first delivery
// keeps its client id BELOW the open siblings above it only when every one of
// them was SENT AFTER it — then the client id is its send position. A sibling
// sent EARLIER whose id is above is a LIFTED id (`mintLivePlacement` places a
// live-turn delivery at the box clock), and keeping the client id under it
// renders the two swapped. Measured 2026-09-22 (sessions YO/134c0d27 on the
// preview, 822e92a4 locally): ALPHA sent 12:15:07 lifted to …a831b000, BRAVO
// sent 12:15:10 kept …a5f79003, the tab drew BRAVO above ALPHA.
describe('underPlacementKeepsSendOrder', () => {
  const alpha = row('00000000-0000-0000-0000-00000000000a', 1_000, '2026-09-22T12:15:07Z', 'msg_000000000002', 'transcript');
  const bravo = row('00000000-0000-0000-0000-00000000000b', 4_000, '2026-09-22T12:15:10Z', 'msg_000000000003', 'transcript');

  test('an open sibling above that was SENT EARLIER (a lifted id) refuses under-placement', () => {
    expect(
      underPlacementKeepsSendOrder({
        row: bravo,
        siblings: [{ wireMessageId: 'msg_000000000fff', row: alpha }],
      }),
    ).toBe(false);
  });

  test('a waiting composer prompt stays under a later steer — every sibling above was sent AFTER it', () => {
    // P1 (composer lane) waited for the turn; P2 (Quick Queue) steered in
    // later and was lifted. P1's client id below P2 IS its send position. The
    // LANE is deliberately not part of "before": by the drain's FIFO P2 runs
    // ahead of P1, but P1 was still the earlier Enter.
    const p1 = row('00000000-0000-0000-0000-0000000000c1', 1_000, '2026-09-22T12:15:07Z', 'msg_000000000002', 'composer');
    const p2 = row('00000000-0000-0000-0000-0000000000c2', 4_000, '2026-09-22T12:15:10Z', 'msg_000000000003', 'transcript');
    expect(
      underPlacementKeepsSendOrder({
        row: p1,
        siblings: [{ wireMessageId: 'msg_000000000fff', row: p2 }],
      }),
    ).toBe(true);
  });

  test('one earlier sibling among later ones is enough to refuse', () => {
    const charlie = row('00000000-0000-0000-0000-00000000000c', 6_000, '2026-09-22T12:15:12Z', 'msg_000000000004', 'transcript');
    expect(
      underPlacementKeepsSendOrder({
        row: bravo,
        siblings: [
          { wireMessageId: 'msg_000000000ffe', row: charlie },
          { wireMessageId: 'msg_000000000fff', row: alpha },
        ],
      }),
    ).toBe(false);
  });

  test('a sibling with NO inbox row (a foreign producer) keeps under-placement', () => {
    expect(
      underPlacementKeepsSendOrder({
        row: bravo,
        siblings: [{ wireMessageId: 'msg_000000000fff', row: null }],
      }),
    ).toBe(true);
  });

  test('no open sibling above: nothing to place under', () => {
    expect(underPlacementKeepsSendOrder({ row: bravo, siblings: [] })).toBe(true);
  });

  test('older producers without an Enter instant compare on the insert instant', () => {
    const early = row('00000000-0000-0000-0000-00000000000d', undefined, '2026-09-22T12:15:07Z', 'msg_000000000002');
    const late = row('00000000-0000-0000-0000-00000000000e', undefined, '2026-09-22T12:15:10Z', 'msg_000000000003');
    expect(underPlacementKeepsSendOrder({ row: late, siblings: [{ wireMessageId: 'x', row: early }] })).toBe(false);
    expect(underPlacementKeepsSendOrder({ row: early, siblings: [{ wireMessageId: 'x', row: late }] })).toBe(true);
  });

  test('a sibling later by its Enter stamp but EARLIER at the server is not "sent after" — a skewed second client cannot re-create the inversion', () => {
    // `clientSentAtMs` is the sender's clock, accepted inside a ten-minute
    // window. Tab A (clock +30 s) sends ALPHA; tab B sends BRAVO 2 s later
    // into the same live turn. By Enter stamps ALPHA is 28 s "later" than
    // BRAVO; by `created_at` it reached the server first. Under-placement
    // needs BOTH clocks to agree the sibling was sent after this row;
    // otherwise the monotonic re-mint wins (review finding, 2026-09-22).
    const alphaSkewed = row('00000000-0000-0000-0000-0000000000d1', 34_000, '2026-09-22T12:15:07Z', 'msg_000000000002', 'transcript');
    const bravoTrue = row('00000000-0000-0000-0000-0000000000d2', 6_000, '2026-09-22T12:15:09Z', 'msg_000000000003', 'transcript');
    expect(
      underPlacementKeepsSendOrder({
        row: bravoTrue,
        siblings: [{ wireMessageId: 'msg_000000000fff', row: alphaSkewed }],
      }),
    ).toBe(false);
    // The mirror: a sibling later at the server but earlier by its Enter
    // stamp (a slow network's late POST from an EARLIER Enter) is not "sent
    // after" either.
    const lateEarlyEnter = row('00000000-0000-0000-0000-0000000000d3', 1_000, '2026-09-22T12:15:12Z', 'msg_000000000001', 'transcript');
    expect(
      underPlacementKeepsSendOrder({
        row: bravoTrue,
        siblings: [{ wireMessageId: 'msg_000000000ffe', row: lateEarlyEnter }],
      }),
    ).toBe(false);
  });

  test('the same Enter millisecond breaks the tie on the client wire id, then the command id', () => {
    const a = row('00000000-0000-0000-0000-0000000000a1', 1_000, '2026-09-22T12:15:07Z', 'msg_000000000002');
    const b = row('00000000-0000-0000-0000-0000000000a2', 1_000, '2026-09-22T12:15:07Z', 'msg_000000000003');
    expect(underPlacementKeepsSendOrder({ row: b, siblings: [{ wireMessageId: 'x', row: a }] })).toBe(false);
    expect(underPlacementKeepsSendOrder({ row: a, siblings: [{ wireMessageId: 'x', row: b }] })).toBe(true);
  });
});
