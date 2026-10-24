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
export const TRIGGER_FILTERS: readonly TriggerFilter[] = ['all', 'cron', 'event', 'app', 'webhook'];

/** An unknown or missing `?type=` is `all`, and so is one the page does not offer (`event` while events are off). */
export function parseTriggerFilter(
  value: string | null | undefined,
  offered: readonly TriggerFilter[] = TRIGGER_FILTERS,
): TriggerFilter {
  return offered.find((f) => f === value) ?? 'all';
}

/**
 * Whether `trigger` starts `agentName`. A trigger that names no agent is
 * stored as `default` (the manifest sentinel, `apps/api/src/projects/lib/
 * triggers.ts`), which means "the project's default agent" — so the default
 * agent's page owns those rows too, or a trigger created with the agent left
 * on its default would show up nowhere.
 */
export function triggerStartsAgent(
  trigger: Pick<ProjectTrigger, 'agent'>,
  agentName: string,
  defaultAgent: string | null | undefined,
): boolean {
  if (trigger.agent === agentName) return true;
  return trigger.agent === 'default' && !!defaultAgent && defaultAgent === agentName;
}

/** The triggers that start `agentName` — the Triggers page in agent scope. */
export function triggersForAgent<T extends Pick<ProjectTrigger, 'agent'>>(
  triggers: readonly T[],
  agentName: string,
  defaultAgent: string | null | undefined = null,
): T[] {
  return triggers.filter((trigger) => triggerStartsAgent(trigger, agentName, defaultAgent));
}

export function filterTriggers(
  triggers: ProjectTrigger[],
  filter: TriggerFilter,
): ProjectTrigger[] {
  return filter === 'all' ? triggers : triggers.filter((t) => t.type === filter);
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
 * `?id=<trigger id>[&tab=settings]` is the open trigger. The ID is the
 * trigger's `slug`, the one identifier the API has (the sheet's Details call
 * it "ID"). Runs is the default tab, so only Settings is written. `?t=<slug>`
 * is the older connector-page link, still read for links already shared.
 */
export function readTriggerSheet(params: Pick<URLSearchParams, 'get'> | null | undefined): {
  slug: string | null;
  tab: TriggerSheetTab;
} {
  return {
    slug: params?.get('id') || params?.get('t') || null,
    tab: params?.get('tab') === 'settings' ? 'settings' : 'runs',
  };
}

/**
 * The URL for opening a trigger (or changing its tab), or for closing
 * (`slug: null`). Every other param (the `?type` filter) is kept.
 *
 * `wasOpen` is whether a trigger is open on screen now: the caller knows it,
 * the URL does not (an unknown `?id` opens nothing). Opening from closed and
 * closing are each a `push`, so Back and Forward step through them. Switching
 * triggers or tabs while open is a `replace`, so clicks do not fill history.
 */
export function triggerSheetHref(
  pathname: string,
  current: string,
  next: { slug: string; tab?: TriggerSheetTab } | { slug: null },
  wasOpen: boolean,
): { href: string; mode: 'push' | 'replace' } {
  const params = new URLSearchParams(current);
  params.delete('t');
  params.delete('tab');
  if (next.slug === null) params.delete('id');
  else {
    params.set('id', next.slug);
    if (next.tab === 'settings') params.set('tab', 'settings');
  }
  const qs = params.toString();
  return {
    href: qs ? `${pathname}?${qs}` : pathname,
    mode: next.slug !== null && wasOpen ? 'replace' : 'push',
  };
}
