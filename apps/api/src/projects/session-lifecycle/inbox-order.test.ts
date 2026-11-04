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

  test('one lane: placement and a Stop batch never reorder rows, send order alone decides', () => {
    // Prod 2026-11-04: lanes delivered a prompt typed last ahead of prompts typed before it.
    const composer = row('00000000-0000-0000-0000-000000000001', 1_000, '2026-08-01T00:00:00Z', '', 'composer');
    const none = row('00000000-0000-0000-0000-000000000002', 2_000, '2026-08-01T00:00:01Z');
    const transcript = row('00000000-0000-0000-0000-000000000003', 3_000, '2026-08-01T00:00:02Z', '', 'transcript');
    (composer.payload as Record<string, unknown>).releasedBatchId = 'b1';

    expect([transcript, none, composer].sort(compareInboxSendOrder)).toEqual([composer, none, transcript]);
  });
});
