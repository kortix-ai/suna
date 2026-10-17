import type { ProjectTrigger } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TriggerTile, clockState } from './trigger-tile';

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

describe('TriggerTile', () => {
  test('ok: the clock with a green reflection and a green dot, named Live', () => {
    const out = renderToStaticMarkup(<TriggerTile trigger={base} />);
    expect(out).toContain('aria-label="Live"');
    expect(out).toContain('text-kortix-green');
    expect(out).toContain('bg-kortix-green');
  });
  test('paused: the health reflection at half strength, a muted dot on the row surface', () => {
    const out = renderToStaticMarkup(
      <TriggerTile trigger={{ ...base, enabled: false }} surface="bg-muted" />,
    );
    expect(out).toContain('aria-label="Paused"');
    expect(out).toContain('text-kortix-green opacity-50');
    expect(out).toContain('bg-muted-foreground');
    expect(out).toContain('rounded-full bg-muted');
  });
  test('every type draws the clock, an app event too', () => {
    const clock = renderToStaticMarkup(<TriggerTile trigger={base} />);
    const event = renderToStaticMarkup(
      <TriggerTile trigger={{ ...base, type: 'event' } as ProjectTrigger} />,
    );
    expect(event).toBe(clock);
  });
});
