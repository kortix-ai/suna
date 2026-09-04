import { sessionTriggerSlug, type ProjectSession, type ProjectTrigger } from '@kortix/sdk';

export interface TriggerRunGroup {
  /** Null for sessions whose `trigger_slug` matches no listed trigger. */
  trigger: ProjectTrigger | null;
  slug: string;
  sessions: ProjectSession[];
}

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
