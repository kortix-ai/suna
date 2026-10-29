// The event log's bounds — the pure half. App events (`type: app`) write the log.
//
// Every bound below is platform-enforced, not user discipline: the writer is App code, so
// an App that emits a million events a minute must cost the platform a
// suppression row, not a million agent turns.
import { describe, expect, test } from 'bun:test';
import {
  MONITOR_AUTO_DISABLE_SUPPRESSIONS,
  MONITOR_LINE_MAX_BYTES,
  MONITOR_RATE_BURST,
  MONITOR_RATE_SUSTAINED_PER_HOUR,
  MONITOR_SUPPRESSION_MS,
  monitorRateVerdict,
  nextMonitorSuppression,
  truncateMonitorLine,
} from '../projects/lib/monitor-events';

describe('line normalization and truncation', () => {
  test('a line inside the bound is stored verbatim', () => {
    const line = { message: 'x'.repeat(100) };
    expect(truncateMonitorLine(line)).toBe(line);
  });

  // One long line must never cost the batch it arrived in — it truncates with
  // a marker instead.
  test('an oversize line truncates with a marker and fits the bound', () => {
    const truncated = truncateMonitorLine({ raw: 'x'.repeat(MONITOR_LINE_MAX_BYTES * 2) });
    expect(truncated.truncated).toBe(true);
    expect(typeof truncated.raw).toBe('string');
    expect(Buffer.byteLength(JSON.stringify(truncated), 'utf8')).toBeLessThanOrEqual(
      MONITOR_LINE_MAX_BYTES,
    );
  });

  test('an oversize structured line keeps its head as raw text', () => {
    const truncated = truncateMonitorLine({
      severity: 'error',
      body: 'y'.repeat(MONITOR_LINE_MAX_BYTES),
    });
    expect(truncated.truncated).toBe(true);
    expect(String(truncated.raw)).toContain('severity');
    expect(Buffer.byteLength(JSON.stringify(truncated), 'utf8')).toBeLessThanOrEqual(
      MONITOR_LINE_MAX_BYTES,
    );
  });

  test('multi-byte characters do not overshoot the byte bound', () => {
    const truncated = truncateMonitorLine({ raw: '✓'.repeat(MONITOR_LINE_MAX_BYTES) });
    expect(Buffer.byteLength(JSON.stringify(truncated), 'utf8')).toBeLessThanOrEqual(
      MONITOR_LINE_MAX_BYTES,
    );
  });
});

describe('monitorRateVerdict', () => {
  const now = new Date('2026-08-12T10:00:00.000Z');

  test('accepts inside both bounds', () => {
    expect(monitorRateVerdict({ hourCount: 5, burstCount: 2, suppressedUntil: null }, now)).toBe(
      'accept',
    );
  });

  test('suppresses at the sustained hourly ceiling', () => {
    expect(
      monitorRateVerdict(
        { hourCount: MONITOR_RATE_SUSTAINED_PER_HOUR, burstCount: 0, suppressedUntil: null },
        now,
      ),
    ).toBe('suppress');
  });

  test('suppresses at the burst ceiling even when the hour is quiet', () => {
    expect(
      monitorRateVerdict(
        { hourCount: 30, burstCount: MONITOR_RATE_BURST, suppressedUntil: null },
        now,
      ),
    ).toBe('suppress');
  });

  test('suppresses while a suppression window is open, and stops when it closes', () => {
    const open = new Date(now.getTime() + 60_000);
    const closed = new Date(now.getTime() - 60_000);
    expect(monitorRateVerdict({ hourCount: 0, burstCount: 0, suppressedUntil: open }, now)).toBe(
      'suppress',
    );
    expect(monitorRateVerdict({ hourCount: 0, burstCount: 0, suppressedUntil: closed }, now)).toBe(
      'accept',
    );
  });
});

describe('nextMonitorSuppression', () => {
  const now = new Date('2026-08-12T10:00:00.000Z');

  test('a first breach opens a 10-minute episode and counts one', () => {
    const state = nextMonitorSuppression({ now, suppressedUntil: null, suppressionCount: null });
    expect(state.suppressedUntil.getTime()).toBe(now.getTime() + MONITOR_SUPPRESSION_MS);
    expect(state.suppressionCount).toBe(1);
    expect(state.autoDisable).toBe(false);
    expect(state.opensNewEpisode).toBe(true);
  });

  test('a breach inside an open episode changes nothing', () => {
    const open = new Date(now.getTime() + 5 * 60_000);
    const state = nextMonitorSuppression({ now, suppressedUntil: open, suppressionCount: 1 });
    expect(state.opensNewEpisode).toBe(false);
    expect(state.suppressionCount).toBe(1);
    expect(state.suppressedUntil.getTime()).toBe(open.getTime());
  });

  test('the third episode inside 24h auto-disables the monitor', () => {
    const lastEpisodeEnd = new Date(now.getTime() - 60 * 60_000);
    const state = nextMonitorSuppression({
      now,
      suppressedUntil: lastEpisodeEnd,
      suppressionCount: MONITOR_AUTO_DISABLE_SUPPRESSIONS - 1,
    });
    expect(state.suppressionCount).toBe(MONITOR_AUTO_DISABLE_SUPPRESSIONS);
    expect(state.autoDisable).toBe(true);
  });

  // The 24h horizon is derived from `suppressed_until` minus the episode
  // length, so an old episode restarts the count instead of accumulating
  // forever into a surprise disable months later.
  test('an episode older than 24h restarts the count at one', () => {
    const ancient = new Date(now.getTime() - 48 * 60 * 60_000);
    const state = nextMonitorSuppression({ now, suppressedUntil: ancient, suppressionCount: 2 });
    expect(state.suppressionCount).toBe(1);
    expect(state.autoDisable).toBe(false);
  });
});
