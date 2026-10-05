import { describe, expect, test } from 'bun:test';
import { compareInboxSendOrder } from './inbox-order';
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

  test('a released Stop batch runs in typing order, whatever each row\'s placement (KRTX-683)', () => {
    const released = (r: SessionLifecycleCommandRow) => {
      (r.payload as Record<string, unknown>).releasedBatchId = 'b1';
      return r;
    };
    const alpha = released(row('00000000-0000-0000-0000-000000000001', 1_000, '2026-08-01T00:00:00Z', '', 'composer'));
    const bravo = released(row('00000000-0000-0000-0000-000000000002', 2_000, '2026-08-01T00:00:01Z', '', 'composer'));
    const charlie = released(row('00000000-0000-0000-0000-000000000003', 3_000, '2026-08-01T00:00:02Z', '', 'transcript'));
    // A Quick Queue send made AFTER the release is not in the batch: it still
    // runs ahead of the Queue List lane.
    const later = row('00000000-0000-0000-0000-000000000004', 4_000, '2026-08-01T00:00:03Z', '', 'transcript');

    expect([charlie, later, bravo, alpha].sort(compareInboxSendOrder)).toEqual([later, alpha, bravo, charlie]);
  });
});
