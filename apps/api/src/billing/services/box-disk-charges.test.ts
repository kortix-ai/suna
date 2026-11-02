// Box disk money logic: which stretch of a box's life is billed at which
// rate, the UTC-day split, the GB-hour math, and the rule that keeps a
// running hour (compute metering's) from being billed again here. The tick
// against PostgreSQL and a fake Platinum is box-disk-charges.integration.test.ts.
import { describe, expect, test } from 'bun:test';
import { boxDiskSpans, boxMeterFrom, BOX_DISK_MAX_DAYS, sliceGbHours, splitByUtcDay } from './box-disk-charges';
import { storageChargeUsd } from './storage-charges';

const T = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

describe('boxDiskSpans', () => {
  test('a stopped box bills from its stop at the stopped rate', () => {
    const spans = boxDiskSpans(
      { state: 'stopped', stoppedAt: '2026-11-01T10:00:00Z', billableSince: '2026-11-01T09:00:00Z' },
      T('2026-11-01T00:00:00Z'),
      T('2026-11-01T12:00:00Z'),
    );
    expect(spans).toEqual([{ kind: 'box_disk', fromMs: T('2026-11-01T10:00:00Z'), toMs: T('2026-11-01T12:00:00Z') }]);
  });

  test('a stopped box restored from an archive bills from the restore', () => {
    // Leaving `archived` re-stamps billableSince: before it the disk was archived, metered on earlier ticks.
    const spans = boxDiskSpans(
      { state: 'stopped', stoppedAt: '2026-10-20T10:00:00Z', billableSince: '2026-11-01T11:00:00Z' },
      T('2026-11-01T06:00:00Z'),
      T('2026-11-01T12:00:00Z'),
    );
    expect(spans).toEqual([{ kind: 'box_disk', fromMs: T('2026-11-01T11:00:00Z'), toMs: T('2026-11-01T12:00:00Z') }]);
  });

  test('an archived box bills stopped until it was archived, then at the archived rate', () => {
    const spans = boxDiskSpans(
      { state: 'archived', stoppedAt: '2026-10-30T04:00:00Z', billableSince: '2026-11-01T04:00:00Z' },
      T('2026-10-31T22:00:00Z'),
      T('2026-11-01T06:00:00Z'),
    );
    expect(spans).toEqual([
      { kind: 'box_disk', fromMs: T('2026-10-31T22:00:00Z'), toMs: T('2026-11-01T04:00:00Z') },
      { kind: 'box_disk_archived', fromMs: T('2026-11-01T04:00:00Z'), toMs: T('2026-11-01T06:00:00Z') },
    ]);
  });

  test('a watermark past the archive bills only archived time', () => {
    const spans = boxDiskSpans(
      { state: 'archived', stoppedAt: '2026-10-30T04:00:00Z', billableSince: '2026-11-01T04:00:00Z' },
      T('2026-11-01T05:00:00Z'),
      T('2026-11-01T06:00:00Z'),
    );
    expect(spans).toEqual([{ kind: 'box_disk_archived', fromMs: T('2026-11-01T05:00:00Z'), toMs: T('2026-11-01T06:00:00Z') }]);
  });

  test('running, starting and archiving boxes bill nothing here', () => {
    for (const state of ['running', 'stopping', 'starting', 'archiving', 'failed-start']) {
      expect(boxDiskSpans({ state, stoppedAt: '2026-11-01T00:00:00Z', billableSince: null }, 0, T('2026-11-02T00:00:00Z'))).toEqual([]);
    }
  });

  test('a box that stopped after the meter ran to now bills nothing', () => {
    expect(
      boxDiskSpans({ state: 'stopped', stoppedAt: '2026-11-01T13:00:00Z', billableSince: null }, 0, T('2026-11-01T12:00:00Z')),
    ).toEqual([]);
  });
});

describe('splitByUtcDay and sliceGbHours', () => {
  test('a span across midnight is one row per day; the GB-hours add up', () => {
    const slices = splitByUtcDay([{ kind: 'box_disk', fromMs: T('2026-10-31T20:00:00Z'), toMs: T('2026-11-02T03:00:00Z') }]);
    expect(slices.map((s) => [s.day, (s.toMs - s.fromMs) / HOUR])).toEqual([
      ['2026-10-31', 4],
      ['2026-11-01', 24],
      ['2026-11-02', 3],
    ]);
    const total = slices.reduce((sum, s) => sum + sliceGbHours(20, s), 0);
    expect(total).toBe(20 * 31);
  });

  test('a 20 GB disk: a stopped day is 480 GB-hours at 72 µ$, an archived day half', () => {
    const day = { fromMs: T('2026-11-01T00:00:00Z'), toMs: T('2026-11-02T00:00:00Z') };
    expect(sliceGbHours(20, day)).toBe(480);
    expect(storageChargeUsd('box_disk', 480)).toBe(0.03456);
    expect(storageChargeUsd('box_disk_archived', 480)).toBe(0.01728);
  });
});

describe('boxMeterFrom: never twice for the same hour', () => {
  const nowMs = T('2026-11-01T12:00:00Z');
  const startMs = T('2026-10-01T00:00:00Z');

  test('an open compute window: compute metering bills the box, this meter skips it', () => {
    expect(boxMeterFrom({ startMs, nowMs, watermarkMs: null, computeWindow: { endedAtMs: null } })).toBeNull();
  });

  test('metering starts at the end of the last compute window', () => {
    const ended = T('2026-11-01T10:30:00Z');
    const from = boxMeterFrom({ startMs, nowMs, watermarkMs: T('2026-11-01T09:00:00Z'), computeWindow: { endedAtMs: ended } });
    expect(from).toBe(ended);
    // A window that billed past Platinum's stop (10:00): the disk between is compute's, not billed here.
    const spans = boxDiskSpans({ state: 'stopped', stoppedAt: '2026-11-01T10:00:00Z', billableSince: null }, from as number, nowMs);
    expect(spans).toEqual([{ kind: 'box_disk', fromMs: ended, toMs: nowMs }]);
  });

  test('the watermark: time already metered is not metered again', () => {
    const watermarkMs = T('2026-11-01T11:00:00Z');
    expect(boxMeterFrom({ startMs, nowMs, watermarkMs, computeWindow: { endedAtMs: T('2026-11-01T10:00:00Z') } })).toBe(watermarkMs);
  });

  test('never before the meter started, never more than the open-day window back', () => {
    const late = T('2026-11-01T11:59:00Z');
    expect(boxMeterFrom({ startMs: late, nowMs, watermarkMs: null, computeWindow: null })).toBe(late);
    expect(boxMeterFrom({ startMs, nowMs, watermarkMs: null, computeWindow: null })).toBe(nowMs - BOX_DISK_MAX_DAYS * 86_400_000);
  });
});
