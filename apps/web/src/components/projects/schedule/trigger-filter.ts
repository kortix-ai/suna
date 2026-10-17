/**
 * The Triggers page filter: `All · Schedules · App events · Webhooks`, kept in
 * the URL as `?type=`, and the by-app grouping of the App events view.
 * Pure, so the counts and the groups are testable without rendering.
 */

import type { ProjectTrigger } from '@kortix/sdk';

import { type EventApp, eventAppName, groupEventApps, indexEventApps } from './event-trigger-copy';
import type { TriggerKind } from './schedule-copy';

export type TriggerFilter = 'all' | TriggerKind;

/** Tab order on the page; the value is the `?type=` it writes. */
export const TRIGGER_FILTERS: readonly TriggerFilter[] = ['all', 'cron', 'event', 'webhook'];

/** An unknown or missing `?type=` is `all`, and so is one the page does not offer (`event` while events are off). */
export function parseTriggerFilter(
  value: string | null | undefined,
  offered: readonly TriggerFilter[] = TRIGGER_FILTERS,
): TriggerFilter {
  return offered.find((f) => f === value) ?? 'all';
}

export function filterTriggers(
  triggers: ProjectTrigger[],
  filter: TriggerFilter,
): ProjectTrigger[] {
  return filter === 'all' ? triggers : triggers.filter((t) => t.type === filter);
}

export function triggerCounts(triggers: ProjectTrigger[]): Record<TriggerFilter, number> {
  const counts: Record<TriggerFilter, number> = {
    all: triggers.length,
    cron: 0,
    event: 0,
    webhook: 0,
  };
  for (const t of triggers) if (t.type in counts) counts[t.type as TriggerKind] += 1;
  return counts;
}

export interface TriggerAppGroup {
  /** Provider app slug, falling back to the connector slug. */
  app: string;
  name: string;
  logo: string | null;
  triggers: ProjectTrigger[];
}

/** App event triggers grouped by app, sorted by app name; logo and name come from the catalog when it has the app. */
export function groupTriggersByApp(
  triggers: ProjectTrigger[],
  apps: EventApp[],
): TriggerAppGroup[] {
  const groups = new Map<string, TriggerAppGroup>();
  const index = indexEventApps(apps);
  for (const t of triggers) {
    if (!t.event) continue;
    const app = t.event.app ?? t.event.connector;
    const group = groups.get(app) ?? {
      app,
      name: eventAppName(t.event, index),
      logo: index.get(app)?.logo ?? null,
      triggers: [],
    };
    group.triggers.push(t);
    groups.set(app, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every app with events, the ones the project already has first. */
export function eventAppStrip(apps: EventApp[]): EventApp[] {
  const { yours, more } = groupEventApps(apps, '');
  return [...yours, ...more];
}

/* ─── The open trigger, in the URL ──────────────────────────────────────── */

export type TriggerSheetTab = 'settings' | 'runs';

/**
 * `?id=<trigger id>[&tab=runs]` is the open trigger. The ID is the trigger's
 * `slug`, the one identifier the API has (the sheet's Details call it "ID").
 * `?t=<slug>` is the older link the connector page writes; it opens the same way.
 */
export function readTriggerSheet(params: Pick<URLSearchParams, 'get'> | null | undefined): {
  slug: string | null;
  tab: TriggerSheetTab;
} {
  return {
    slug: params?.get('id') || params?.get('t') || null,
    tab: params?.get('tab') === 'runs' ? 'runs' : 'settings',
  };
}

/**
 * The URL for opening one trigger, or for closing (`slug: null`). Every other
 * param (the `?type` filter) is kept. Opening from a closed sheet is a `push`,
 * so Back closes it again. Switching triggers and closing are a `replace`, so
 * clicks do not fill the history.
 */
export function triggerSheetHref(
  pathname: string,
  current: string,
  next: { slug: string; tab?: TriggerSheetTab } | { slug: null },
): { href: string; mode: 'push' | 'replace' } {
  const params = new URLSearchParams(current);
  const wasOpen = readTriggerSheet(params).slug !== null;
  params.delete('t');
  params.delete('tab');
  if (next.slug === null) params.delete('id');
  else {
    params.set('id', next.slug);
    if ('tab' in next && next.tab === 'runs') params.set('tab', 'runs');
  }
  const qs = params.toString();
  return {
    href: qs ? `${pathname}?${qs}` : pathname,
    mode: next.slug !== null && !wasOpen ? 'push' : 'replace',
  };
}
