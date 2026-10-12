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
