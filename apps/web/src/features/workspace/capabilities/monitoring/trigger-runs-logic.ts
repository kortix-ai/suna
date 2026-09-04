import {
  sessionDisplayStatus,
  type SessionDisplayStatus,
} from '@/components/projects/session-label';
import { sessionTriggerSlug, type ProjectSession, type ProjectTrigger } from '@kortix/sdk';

import { needsApproval } from './stage-board-logic';

export interface TriggerRunGroup {
  /** Null for sessions whose `trigger_slug` matches no listed trigger. */
  trigger: ProjectTrigger | null;
  slug: string;
  /** Newest first. */
  sessions: ProjectSession[];
}

/** How many glyphs a trigger row shows before the rest hide behind "open". */
export const RUN_STRIP_LENGTH = 12;

/** Legend order — the statuses a run can be in, live/actionable first. */
export const RUN_LEGEND: readonly SessionDisplayStatus[] = [
  'running',
  'needs-you',
  'done',
  'failed',
  'stopped',
];

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * One group per listed trigger (listing order, even with zero runs), then one
 * per unknown slug ("other triggers"), sorted by slug. Sessions with no
 * trigger are not runs and are dropped. Runs are newest first.
 */
export function groupSessionsByTrigger(
  sessions: readonly ProjectSession[],
  triggers: readonly ProjectTrigger[],
): TriggerRunGroup[] {
  const listed = new Map<string, TriggerRunGroup>();
  for (const trigger of triggers) {
    listed.set(trigger.slug, { trigger, slug: trigger.slug, sessions: [] });
  }
  const orphans = new Map<string, TriggerRunGroup>();
  for (const session of sessions) {
    const slug = sessionTriggerSlug(session);
    if (!slug) continue;
    let group = listed.get(slug) ?? orphans.get(slug);
    if (!group) {
      group = { trigger: null, slug, sessions: [] };
      orphans.set(slug, group);
    }
    group.sessions.push(session);
  }
  const groups = [
    ...listed.values(),
    ...[...orphans.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
  ];
  for (const group of groups) {
    group.sessions.sort((a, b) => ms(b.created_at) - ms(a.created_at));
  }
  return groups;
}

/**
 * A run's display status. "Needs you" covers both an open review item on the
 * session (the sidebar's rule) and a card parked in Ready with
 * `--needs-approval` — either way a person has to act before it moves.
 */
export function runDisplayStatus(
  session: ProjectSession,
  needsYouBySession: Readonly<Record<string, number>> = {},
): SessionDisplayStatus {
  const reviewCount =
    (needsYouBySession[session.session_id] ?? 0) + (needsApproval(session) ? 1 : 0);
  return sessionDisplayStatus(session, reviewCount);
}

/** The last `RUN_STRIP_LENGTH` runs, oldest → newest, so the strip reads left to right in time. */
export function runStrip(group: TriggerRunGroup): ProjectSession[] {
  return group.sessions.slice(0, RUN_STRIP_LENGTH).reverse();
}

export interface RunTotals {
  triggers: number;
  runs: number;
  failed: number;
  needsYou: number;
}

export function summarizeRuns(
  groups: readonly TriggerRunGroup[],
  needsYouBySession: Readonly<Record<string, number>> = {},
): RunTotals {
  const totals: RunTotals = { triggers: groups.length, runs: 0, failed: 0, needsYou: 0 };
  for (const group of groups) {
    for (const session of group.sessions) {
      totals.runs += 1;
      const status = runDisplayStatus(session, needsYouBySession);
      if (status === 'failed') totals.failed += 1;
      if (status === 'needs-you') totals.needsYou += 1;
    }
  }
  return totals;
}
