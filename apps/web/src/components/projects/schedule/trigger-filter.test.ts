import type { ProjectTrigger } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import type { EventApp } from './event-trigger-copy';
import {
  eventAppStrip,
  filterTriggers,
  groupTriggersByApp,
  TRIGGER_FILTERS,
  parseTriggerFilter,
  triggerCounts,
} from './trigger-filter';

const trigger = (slug: string, type: string, app?: string, connector = app): ProjectTrigger =>
  ({
    slug,
    type,
    event: app ? { app, connector, type: `${app.toUpperCase()}_EVENT` } : null,
  }) as unknown as ProjectTrigger;

const list = [
  trigger('a', 'cron'),
  trigger('b', 'webhook'),
  trigger('c', 'event', 'github'),
  trigger('d', 'event', 'gmail'),
  trigger('e', 'event', 'github', 'github-work'),
];

const app = (slug: string, over: Partial<EventApp> = {}): EventApp => ({
  provider: 'composio',
  app: slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  logo: `https://logos.test/${slug}.png`,
  event_count: 3,
  connector: null,
  connected: false,
  ...over,
});

describe('parseTriggerFilter', () => {
  test('accepts the four kinds', () => {
    for (const v of ['all', 'cron', 'event', 'webhook']) expect(parseTriggerFilter(v)).toBe(v);
  });
  test('falls back to all', () => {
    expect(parseTriggerFilter(null)).toBe('all');
    expect(parseTriggerFilter('monitor')).toBe('all');
  });
  test('a filter the page does not offer is all: ?type=event with events off', () => {
    const offered = TRIGGER_FILTERS.filter((f) => f !== 'event');
    expect(parseTriggerFilter('event', offered)).toBe('all');
    expect(parseTriggerFilter('cron', offered)).toBe('cron');
  });
});

describe('counts and filter', () => {
  test('counts every kind', () => {
    expect(triggerCounts(list)).toEqual({ all: 5, cron: 1, event: 3, webhook: 1 });
  });
  test('filters by kind', () => {
    expect(filterTriggers(list, 'event').map((t) => t.slug)).toEqual(['c', 'd', 'e']);
    expect(filterTriggers(list, 'all')).toHaveLength(5);
  });
});

describe('groupTriggersByApp', () => {
  test('groups profiles of one app together, by app name, with the catalog logo', () => {
    const events = [list[3], ...filterTriggers(list, 'event').filter((t) => t.slug !== 'd')];
    const groups = groupTriggersByApp(events, [app('github')]);
    expect(groups.map((g) => [g.app, g.triggers.length])).toEqual([
      ['github', 2],
      ['gmail', 1],
    ]);
    expect(groups[0].logo).toBe('https://logos.test/github.png');
    expect(groups[1].logo).toBeNull();
    expect(groups[0].name).toBe('Github');
    // Not in the catalog: the slug as written, never a capitalised one.
    expect(groups[1].name).toBe('gmail');
  });
});

describe('eventAppStrip', () => {
  test('apps the project has come first', () => {
    const strip = eventAppStrip([app('asana'), app('github', { connector: 'github' }), app('gmail')]);
    expect(strip.map((a) => a.app)).toEqual(['github', 'gmail', 'asana']);
  });
});
