/**
 * The space watcher's tables (flag `spaces_proactive`): the settings and wake
 * state per space (`project_space_watchers`) and the event feed
 * (`project_space_events`). An event is written only while the space's
 * watcher is on and both flags (`chat`, `spaces_proactive`) are on for the
 * project: a project that never turns it on pays one primary-key read per
 * finished thread turn, nothing more.
 */
import { projectSpaceEvents, projectSpaces, projectSpaceWatchers } from '@kortix/db';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../../feature-flags/registry';
import { logger } from '../../../lib/logger';
import { db } from '../../../shared/db';
import { qualifiedColumn } from '../../../shared/sql-qualified-column';
import { SPACE_EVENTS_KEEP, SPACE_EVENTS_RETENTION_DAYS, type SpaceEventKind } from './policy';
import { projectsView } from '../../../workspaces/rows';

export type WatcherRow = typeof projectSpaceWatchers.$inferSelect;

/** Both flags on for this project. */
export function proactiveOn(projectMetadata: unknown): boolean {
  return resolveFeatureFlag(projectMetadata, 'chat') && resolveFeatureFlag(projectMetadata, 'spaces_proactive');
}

export async function readWatcher(spaceId: string): Promise<WatcherRow | null> {
  const [row] = await db.select().from(projectSpaceWatchers).where(eq(projectSpaceWatchers.spaceId, spaceId)).limit(1);
  return row ?? null;
}

/** The watch row whose session is `sessionId`, or null: a session is the watcher of at most one space. */
export async function watcherOfSession(sessionId: string): Promise<WatcherRow | null> {
  const [row] = await db.select().from(projectSpaceWatchers).where(eq(projectSpaceWatchers.watcherSessionId, sessionId)).limit(1);
  return row ?? null;
}

/** True when `sessionId` is the watcher of `spaceId`. */
export async function isWatcherOfSpace(sessionId: string, spaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ spaceId: projectSpaceWatchers.spaceId })
    .from(projectSpaceWatchers)
    .where(and(eq(projectSpaceWatchers.spaceId, spaceId), eq(projectSpaceWatchers.watcherSessionId, sessionId)))
    .limit(1);
  return !!row;
}

/** Turn Proactive or the daily brief on or off. The first write names the person the watcher works for. */
export async function writeWatcher(input: {
  projectId: string;
  spaceId: string;
  ownerUserId: string;
  actorId: string;
  enabled?: boolean;
  dailyBrief?: boolean;
  briefTimezone?: string;
}): Promise<WatcherRow> {
  const patch = {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.dailyBrief !== undefined ? { dailyBrief: input.dailyBrief } : {}),
    ...(input.briefTimezone !== undefined ? { briefTimezone: input.briefTimezone } : {}),
    updatedBy: input.actorId,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(projectSpaceWatchers)
    .values({ spaceId: input.spaceId, projectId: input.projectId, ownerUserId: input.ownerUserId, ...patch })
    .onConflictDoUpdate({ target: projectSpaceWatchers.spaceId, set: patch })
    .returning();
  return row!;
}

/**
 * Append one event to a space's feed when its watcher is on. A repeated
 * `dedupeKey` writes nothing. Keeps at most `SPACE_EVENTS_KEEP` rows per
 * space. Returns the new row's id, or null (off, or a repeat). Never throws.
 */
export async function recordSpaceEvent(input: {
  spaceId: string;
  kind: SpaceEventKind;
  line: string;
  dedupeKey: string;
  urgent?: boolean;
}): Promise<number | null> {
  try {
    const [watch] = await db
      .select({ enabled: projectSpaceWatchers.enabled, metadata: projectsView.metadata })
      .from(projectSpaceWatchers)
      .innerJoin(projectsView, eq(projectsView.projectId, projectSpaceWatchers.projectId))
      .where(eq(projectSpaceWatchers.spaceId, input.spaceId))
      .limit(1);
    if (!watch?.enabled || !proactiveOn(watch.metadata)) return null;
    const [row] = await db
      .insert(projectSpaceEvents)
      .values({ spaceId: input.spaceId, kind: input.kind, line: input.line, dedupeKey: input.dedupeKey.slice(0, 200), urgent: input.urgent === true })
      .onConflictDoNothing()
      .returning({ eventId: projectSpaceEvents.eventId });
    if (!row) return null;
    // Rows past the newest SPACE_EVENTS_KEEP of this space.
    await db.execute(sql`
      DELETE FROM kortix.project_space_events
       WHERE space_id = ${input.spaceId}
         AND event_id < (SELECT event_id FROM kortix.project_space_events
                          WHERE space_id = ${input.spaceId}
                          ORDER BY event_id DESC OFFSET ${SPACE_EVENTS_KEEP - 1} LIMIT 1)`);
    logger.info('[space-watch] event', { space_id: input.spaceId, kind: input.kind, event_id: row.eventId });
    return row.eventId;
  } catch (error) {
    logger.warn('[space-watch] the event was not recorded', {
      space_id: input.spaceId,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** An enabled watcher with what the tick needs to decide. */
export interface WatchCandidate {
  watch: WatcherRow;
  projectMetadata: unknown;
  accountId: string;
  space: typeof projectSpaces.$inferSelect;
  pending: number;
  urgent: boolean;
  lastDay: number;
}

/** Every enabled watcher of a live space, with its new-event counts. One query. */
export async function loadWatchCandidates(now: Date): Promise<WatchCandidate[]> {
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const rows = await db
    .select({
      watch: projectSpaceWatchers,
      projectMetadata: projectsView.metadata,
      accountId: projectsView.accountId,
      space: projectSpaces,
      pending: sql<number>`(SELECT count(*)::int FROM kortix.project_space_events e WHERE e.space_id = ${qualifiedColumn(projectSpaceWatchers.spaceId)} AND e.event_id > ${qualifiedColumn(projectSpaceWatchers.cursor)})`,
      urgent: sql<boolean>`EXISTS (SELECT 1 FROM kortix.project_space_events e WHERE e.space_id = ${qualifiedColumn(projectSpaceWatchers.spaceId)} AND e.event_id > ${qualifiedColumn(projectSpaceWatchers.cursor)} AND e.urgent)`,
      lastDay: sql<number>`(SELECT count(*)::int FROM kortix.project_space_events e WHERE e.space_id = ${qualifiedColumn(projectSpaceWatchers.spaceId)} AND e.created_at > ${dayAgo.toISOString()}::timestamptz)`,
    })
    .from(projectSpaceWatchers)
    .innerJoin(projectsView, eq(projectsView.projectId, projectSpaceWatchers.projectId))
    .innerJoin(projectSpaces, eq(projectSpaces.spaceId, projectSpaceWatchers.spaceId))
    .where(and(eq(projectSpaceWatchers.enabled, true), sql`${projectSpaces.archivedAt} IS NULL`));
  return rows.filter((row) => proactiveOn(row.projectMetadata));
}

export interface SpaceEventRow {
  eventId: number;
  line: string;
  kind: string;
  createdAt: Date;
}

/** Events after `cursor`, oldest first, at most `limit`, and how many more wait. */
export async function eventsAfter(spaceId: string, cursor: number, limit: number): Promise<{ rows: SpaceEventRow[]; more: number }> {
  const rows = await db
    .select({ eventId: projectSpaceEvents.eventId, line: projectSpaceEvents.line, kind: projectSpaceEvents.kind, createdAt: projectSpaceEvents.createdAt })
    .from(projectSpaceEvents)
    .where(and(eq(projectSpaceEvents.spaceId, spaceId), gt(projectSpaceEvents.eventId, cursor)))
    .orderBy(asc(projectSpaceEvents.eventId))
    .limit(limit + 1);
  const [{ count } = { count: 0 }] = rows.length > limit
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(projectSpaceEvents)
        .where(and(eq(projectSpaceEvents.spaceId, spaceId), gt(projectSpaceEvents.eventId, rows[limit - 1]!.eventId)))
    : [];
  return { rows: rows.slice(0, limit), more: count };
}

/** Events of the last day (the brief), oldest first, at most `limit`. */
export async function eventsSince(spaceId: string, since: Date, limit: number): Promise<SpaceEventRow[]> {
  const rows = await db
    .select({ eventId: projectSpaceEvents.eventId, line: projectSpaceEvents.line, kind: projectSpaceEvents.kind, createdAt: projectSpaceEvents.createdAt })
    .from(projectSpaceEvents)
    .where(and(eq(projectSpaceEvents.spaceId, spaceId), gt(projectSpaceEvents.createdAt, since)))
    .orderBy(desc(projectSpaceEvents.eventId))
    .limit(limit);
  return rows.reverse();
}

/** The newest lines of a space, oldest first (`events.md`). */
export async function latestLines(spaceId: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ line: projectSpaceEvents.line })
    .from(projectSpaceEvents)
    .where(eq(projectSpaceEvents.spaceId, spaceId))
    .orderBy(desc(projectSpaceEvents.eventId))
    .limit(limit);
  return rows.map((row) => row.line).reverse();
}

/** Record one wake: the new cursor, the day's count, the brief day. */
export async function markWake(input: {
  spaceId: string;
  cursor: number;
  at: Date;
  utcDay: string;
  wakesOnDay: number;
  briefOn: string | null;
  watcherSessionId: string;
}): Promise<void> {
  await db
    .update(projectSpaceWatchers)
    .set({
      // Never backwards: a brief shows older lines and leaves the cursor where it was.
      cursor: sql`greatest(${projectSpaceWatchers.cursor}, ${input.cursor})`,
      lastWakeAt: input.at,
      wakeDay: input.utcDay,
      wakesOnDay: input.wakesOnDay,
      watcherSessionId: input.watcherSessionId,
      ...(input.briefOn ? { lastBriefOn: input.briefOn } : {}),
    })
    .where(eq(projectSpaceWatchers.spaceId, input.spaceId));
}

/** Claim one watcher answer: true for the first claim of `decisionId`, false for a repeat. */
export async function claimDecision(spaceId: string, decisionId: string): Promise<boolean> {
  const rows = await db
    .update(projectSpaceWatchers)
    .set({ lastDecisionId: decisionId })
    .where(and(eq(projectSpaceWatchers.spaceId, spaceId), sql`${projectSpaceWatchers.lastDecisionId} IS DISTINCT FROM ${decisionId}`))
    .returning({ spaceId: projectSpaceWatchers.spaceId });
  return rows.length > 0;
}

/** Delete events older than the retention. Returns the rows deleted. */
export async function pruneSpaceEvents(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SPACE_EVENTS_RETENTION_DAYS * 86_400_000);
  const rows = await db.delete(projectSpaceEvents).where(lt(projectSpaceEvents.createdAt, cutoff)).returning({ eventId: projectSpaceEvents.eventId });
  return rows.length;
}

/** The spaces of these sessions (top-level threads), for the overdue-ask scan. */
export async function spacesOfSessions(sessionIds: readonly string[]): Promise<Map<string, { spaceId: string; title: string | null }>> {
  if (sessionIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT session_id, space_id::text AS space_id, coalesce(metadata->>'custom_name', metadata->>'name') AS title
      FROM kortix.project_sessions
     WHERE session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)}) AND space_id IS NOT NULL`)) as unknown as Array<{ session_id: string; space_id: string; title: string | null }>;
  return new Map(rows.map((row) => [row.session_id, { spaceId: row.space_id, title: row.title }]));
}

