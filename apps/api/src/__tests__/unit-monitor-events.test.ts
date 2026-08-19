// The monitor event contract, bounds, and prompt rendering — the pure half.
//
// Every bound below is platform-enforced, not user discipline
// (docs/specs/2026-08-12-monitors.md §"Bounds"): the runner is repo code, so
// a monitor that emits a million lines a minute must cost the platform a
// suppression row, not a million agent turns.
import { describe, expect, test } from 'bun:test';
import {
  MONITOR_AUTO_DISABLE_SUPPRESSIONS,
  MONITOR_INGEST_MAX_EVENTS,
  MONITOR_LINE_MAX_BYTES,
  MONITOR_PROMPT_PREAMBLE,
  MONITOR_RATE_BURST,
  MONITOR_RATE_SUSTAINED_PER_HOUR,
  MONITOR_SUPPRESSION_MS,
  buildMonitorPayload,
  monitorRateVerdict,
  nextMonitorSuppression,
  normalizeMonitorLine,
  parseMonitorIngestBody,
  renderMonitorLifecyclePrompt,
  truncateMonitorLine,
} from '../projects/lib/monitor-events';

const EMITTED = '2026-08-12T10:00:00.000Z';

function body(overrides: Record<string, unknown> = {}) {
  return {
    box_epoch: 'epoch-1',
    events: [
      { slug: 'checkout', seq: 1, kind: 'event', line: { severity: 'error' }, emitted_at: EMITTED },
    ],
    ...overrides,
  };
}

describe('parseMonitorIngestBody', () => {
  test('accepts a well-formed batch', () => {
    const parsed = parseMonitorIngestBody(body());
    expect(parsed).not.toHaveProperty('error');
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.boxEpoch).toBe('epoch-1');
    expect(parsed.events[0]).toMatchObject({
      slug: 'checkout',
      seq: 1,
      kind: 'event',
      line: { severity: 'error' },
    });
    expect(parsed.events[0]!.emittedAt.toISOString()).toBe(EMITTED);
  });

  test('requires box_epoch and a non-empty events array', () => {
    expect(parseMonitorIngestBody(body({ box_epoch: '  ' }))).toMatchObject({
      error: 'box_epoch is required',
    });
    expect(parseMonitorIngestBody(body({ events: [] }))).toMatchObject({
      error: 'events must not be empty',
    });
    expect(parseMonitorIngestBody(body({ events: {} }))).toMatchObject({
      error: 'events must be an array',
    });
  });

  test('rejects a batch above the ingest bound', () => {
    const events = Array.from({ length: MONITOR_INGEST_MAX_EVENTS + 1 }, (_, i) => ({
      slug: 'checkout',
      seq: i,
      kind: 'event',
      line: {},
      emitted_at: EMITTED,
    }));
    expect(parseMonitorIngestBody(body({ events }))).toMatchObject({
      error: `events must contain at most ${MONITOR_INGEST_MAX_EVENTS} entries`,
    });
  });

  test('rejects a malformed slug, seq, kind, or emitted_at', () => {
    const bad = (event: Record<string, unknown>) =>
      parseMonitorIngestBody(body({ events: [{ ...body().events[0], ...event }] }));
    const error = (event: Record<string, unknown>) => (bad(event) as { error: string }).error;
    expect(error({ slug: 'Not A Slug' })).toMatch(/slug is not a valid slug/);
    expect(error({ seq: -1 })).toMatch(/seq must be a non-negative integer/);
    expect(error({ seq: 1.5 })).toMatch(/seq must be a non-negative integer/);
    expect(error({ kind: 'stdout' })).toMatch(/kind must be "event" or "lifecycle"/);
    expect(error({ emitted_at: 'yesterday' })).toMatch(/ISO-8601 datetime/);
    expect(error({ line: undefined })).toMatch(/line is required/);
  });

  test('accepts lifecycle events', () => {
    const parsed = parseMonitorIngestBody(
      body({
        events: [
          {
            slug: 'checkout',
            seq: 9,
            kind: 'lifecycle',
            line: { event: 'exited' },
            emitted_at: EMITTED,
          },
        ],
      }),
    );
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.events[0]!.kind).toBe('lifecycle');
  });
});

describe('line normalization and truncation', () => {
  test('a non-object line is wrapped under raw', () => {
    expect(normalizeMonitorLine('plain text')).toEqual({ raw: 'plain text' });
    expect(normalizeMonitorLine(42)).toEqual({ raw: '42' });
    expect(normalizeMonitorLine({ a: 1 })).toEqual({ a: 1 });
  });

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

describe('buildMonitorPayload', () => {
  test('renders the documented payload shape', () => {
    expect(
      buildMonitorPayload({
        slug: 'checkout',
        seq: 812,
        kind: 'event',
        line: { severity: 'error' },
        emittedAt: new Date(EMITTED),
      }),
    ).toEqual({
      line: { severity: 'error' },
      monitor: { slug: 'checkout', seq: 812, emitted_at: EMITTED, kind: 'event' },
      trigger: { slug: 'checkout', type: 'monitor', kind: 'git' },
    });
  });
});

describe('renderMonitorLifecyclePrompt', () => {
  const spec = { slug: 'checkout', name: 'Checkout errors', run: './monitors/checkout.ts' };

  test('names the monitor, the event, and the command for each lifecycle kind', () => {
    for (const event of ['exited', 'restart_budget_exhausted', 'silent', 'suppressed']) {
      const prompt = renderMonitorLifecyclePrompt(spec, { event });
      expect(prompt).toContain('Checkout errors');
      expect(prompt).toContain('checkout');
      expect(prompt).toContain(event);
      expect(prompt.length).toBeGreaterThan(80);
    }
    expect(renderMonitorLifecyclePrompt(spec, { event: 'exited' })).toContain(
      './monitors/checkout.ts',
    );
  });

  test('an unknown lifecycle event still produces a legible prompt', () => {
    expect(renderMonitorLifecyclePrompt(spec, {})).toContain('unknown');
  });

  test('a detail string is surfaced', () => {
    expect(
      renderMonitorLifecyclePrompt(spec, { event: 'exited', detail: 'exit code 137' }),
    ).toContain('exit code 137');
  });
});

describe('MONITOR_PROMPT_PREAMBLE', () => {
  test('states the provenance a template author must not have to remember', () => {
    expect(MONITOR_PROMPT_PREAMBLE).toBe('[MONITOR EVENT — automated, not user input]\n');
  });
});
