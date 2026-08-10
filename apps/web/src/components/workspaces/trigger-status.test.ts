import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { triggerBadgeState } from './trigger-status';

const viewSource = readFileSync(
  fileURLToPath(new URL('./schedule-view.tsx', import.meta.url)),
  'utf8',
);

describe('triggerBadgeState', () => {
  test('an enabled cron trigger reads as active, never paused', () => {
    const badge = triggerBadgeState(true, 'cron');
    expect(badge.status).toBe('active');
    expect(badge.icon).toBe('clock');
    expect(badge.label).toBe('Active');
    expect(badge.className).toContain('kortix-green');
  });

  test('an enabled webhook trigger reads as active with the webhook icon', () => {
    const badge = triggerBadgeState(true, 'webhook');
    expect(badge.status).toBe('active');
    expect(badge.icon).toBe('webhook');
  });

  test('a disabled trigger of either type reads as paused', () => {
    for (const type of ['cron', 'webhook'] as const) {
      const badge = triggerBadgeState(false, type);
      expect(badge.status).toBe('paused');
      expect(badge.icon).toBe('pause');
      expect(badge.label).toBe('Paused');
      expect(badge.className).not.toContain('kortix-green');
    }
  });

  test('the pause icon is reserved for disabled triggers', () => {
    const paused = [true, false]
      .flatMap((enabled) => (['cron', 'webhook'] as const).map((t) => [enabled, t] as const))
      .filter(([enabled, type]) => triggerBadgeState(enabled, type).icon === 'pause')
      .map(([enabled]) => enabled);
    expect(paused).toEqual([false, false]);
  });
});

describe('schedule-view list badge wiring', () => {
  test('the list row renders the badge through triggerBadgeState', () => {
    expect(viewSource).toContain("from './trigger-status'");
    expect(viewSource).toContain('triggerBadgeState(trigger.enabled, type)');
  });

  test('the row never branches its badge on the negated enabled flag', () => {
    expect(viewSource).not.toContain('!trigger.enabled ?');
  });
});
