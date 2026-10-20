import type { ProjectTrigger } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CLOCK_TONE, TriggerTile, clockState } from './trigger-tile';

const base = {
  slug: 'digest',
  type: 'cron',
  enabled: true,
  last_fired_at: '2026-10-01T06:00:00.000Z',
  last_status: 'fired',
  event: null,
} as unknown as ProjectTrigger;

describe('clockState', () => {
  test('a healthy trigger that ran is ok; one that never ran is never', () => {
    expect(clockState(base)).toBe('ok');
    expect(clockState({ ...base, last_fired_at: null })).toBe('never');
  });
  test('a failed last run is failed; paused wins over both', () => {
    expect(clockState({ ...base, last_status: 'failed' })).toBe('failed');
    expect(clockState({ ...base, enabled: false, last_status: 'failed' })).toBe('paused');
  });
});

describe('CLOCK_TONE', () => {
  test('the dot always carries the reflection’s hue, at the same strength', () => {
    for (const tone of Object.values(CLOCK_TONE)) {
      expect(tone.dot.replace('bg-', '')).toBe(tone.reflection.replace('text-', ''));
    }
  });
  test('the project-wide pause pauses every clock', () => {
    expect(clockState(base, true)).toBe('paused');
  });
});

describe('TriggerTile', () => {
  test('ok: a green reflection and a green dot, named Live', () => {
    const out = renderToStaticMarkup(<TriggerTile trigger={base} />);
    expect(out).toContain('aria-label="Live"');
    expect(out).toContain('text-kortix-green');
    expect(out).toContain('bg-kortix-green');
  });
  test('paused: a yellow reflection and a yellow dot; the disc follows the row', () => {
    const out = renderToStaticMarkup(<TriggerTile trigger={base} projectPaused surface="row" />);
    expect(out).toContain('aria-label="Paused"');
    expect(out).toContain('text-kortix-yellow');
    expect(out).toContain('bg-kortix-yellow');
    expect(out).not.toContain('kortix-green');
    expect(out).not.toContain('opacity-50');
    expect(out).toContain('bg-(--row-surface)');
  });
  test('never run is live: green, never a grey clock', () => {
    const out = renderToStaticMarkup(<TriggerTile trigger={{ ...base, last_fired_at: null }} />);
    expect(out).toContain('text-kortix-green');
    expect(out).toContain('bg-kortix-green');
  });
  test('every type draws the clock, an app event too', () => {
    const clock = renderToStaticMarkup(<TriggerTile trigger={base} />);
    const event = renderToStaticMarkup(
      <TriggerTile trigger={{ ...base, type: 'event' } as ProjectTrigger} />,
    );
    expect(event).toBe(clock);
  });
});
