/**
 * The space watcher's wakes (flag `spaces_proactive`). The `space-watcher`
 * job calls `runSpaceWatcherTick` every 2 minutes on the leader:
 *
 * 1. Delete events past the 14-day retention.
 * 2. Record an `ask_overdue` event (urgent) for each ask that has waited for
 *    a person longer than `KORTIX_SPACE_WATCH_ASK_OVERDUE_MS` (2 h) in a
 *    space whose watcher is on. One event per ask, ever (`dedupe_key`).
 * 3. For each enabled watcher, `decideWake` (policy.ts): at most one wake per
 *    `KORTIX_SPACE_WATCH_DEBOUNCE_MS` (10 min) unless urgent, at most
 *    `WATCH_DAILY_WAKES` (24) per UTC day, the daily brief at 09:00 local.
 * 4. A wake writes `events.md` into the space folder, then delivers ONE
 *    prompt to a fresh watcher session (one per wake, so none grows): the
 *    new events, the space's context.md and the watcher's recent posts. The
 *    watcher's answer is carried out at its turn end (`act.ts`).
 *
 * The scan reads only enabled watchers (a partial index); a project with none
 * costs this job nothing.
 */
import { projectSessions, type projectSpaces } from '@kortix/db';
import { spaceDriveFolders } from '@kortix/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../../../config';
import { findProjectDrive, listFolderGrants, personalFolderFor, type DriveRow } from '../../../drives/service';
import { logger } from '../../../lib/logger';
import { volumeOps } from '../../../memory/volume-ops';
import { db } from '../../../shared/db';
import { createSession } from '../../session-lifecycle';
import { CHAT_AGENT, CHAT_ROOT_TEXT_KEY } from '../chat-threads';
import { listOpenAsks } from '../session-asks';
import type { ProjectRow } from '../serializers';
import { resolveUserIdentities } from '../user-identity';
import { mentionOf } from './act';
import { SPACE_WATCHER_SOURCE, WATCHER_POST_METADATA_KEY, WATCHER_SPACE_METADATA_KEY } from './keys';
import { decideWake, eventLine, eventsFileText, EVENTS_FILE_LINES, WAKE_EVENTS_MAX, wakePromptText, type WakeReason } from './policy';
import {
  eventsAfter,
  eventsSince,
  latestLines,
  loadWatchCandidates,
  markWake,
  pruneSpaceEvents,
  recordSpaceEvent,
  spacesOfSessions,
  type WatchCandidate,
  type WatcherRow,
} from './store';
import { projectsView } from '../../../workspaces/rows';

type SpaceRow = typeof projectSpaces.$inferSelect;

/** How many of the watcher's own posts each wake shows it. */
const OWN_POSTS_SHOWN = 5;

/** The space's files folder in Drive, or null (no Drive, a DM whose owner has no folder). */
export async function spaceFolderFor(space: SpaceRow): Promise<{ drive: DriveRow; folder: string } | null> {
  const drive = await findProjectDrive(space.projectId);
  if (!drive) return null;
  if (space.kind === 'channel') {
    const folder = space.slug ? spaceDriveFolders('channel', space.slug, null, space.visibility === 'private' ? space.spaceId : null)?.files : null;
    return folder ? { drive, folder } : null;
  }
  if (!space.dmUserId || !space.dmAgentName) return null;
  const personal = personalFolderFor(await listFolderGrants(drive), space.dmUserId);
  const folder = personal ? spaceDriveFolders('dm', space.dmAgentName, personal)?.files : null;
  return folder ? { drive, folder } : null;
}

/** "#launch", or the person's own space. */
export function spacePlace(space: Pick<SpaceRow, 'kind' | 'slug' | 'name'>): string {
  return space.kind === 'channel' ? `#${space.slug ?? space.name}` : `the private space "${space.name}"`;
}

/** The agent the watcher runs: the space's default agent (a DM's agent), else My Kortix. */
export function watcherAgent(space: Pick<SpaceRow, 'kind' | 'agents' | 'dmAgentName'>): string {
  return space.kind === 'dm' ? (space.dmAgentName ?? CHAT_AGENT) : (space.agents?.[0] ?? CHAT_AGENT);
}

/** Creates a wake's session; tests record the call instead (`setWakeSessionCreatorForTests`). */
let createWakeSession: typeof createSession = createSession;
export function setWakeSessionCreatorForTests(create: typeof createSession | null): void {
  createWakeSession = create ?? createSession;
}

/**
 * Deliver one wake prompt: every wake is a fresh session with the prompt as its
 * first message. The watcher's memory is the space's files (`events.md`,
 * `context.md`) and its own posts, so no session carries a growing context or
 * depends on one box staying alive. The session is private to the owner, not
 * filed in the space (so no thread list shows it), source
 * `system:space-watcher` (so session-create gives it `kortix.watcher`).
 */
async function deliverWake(input: { project: ProjectRow; space: SpaceRow; watch: WatcherRow; text: string; key: string }): Promise<string | null> {
  const result = await createWakeSession({
    source: SPACE_WATCHER_SOURCE,
    project: input.project,
    userId: input.watch.ownerUserId,
    requestingPrincipalType: 'human',
    // `space_id: null`: filed in no space. Without it, session create files the session in #general.
    body: { agent_name: watcherAgent(input.space), initial_prompt: input.text, space_id: null },
    metadata: { name: `Watcher · ${spacePlace(input.space)}`, [WATCHER_SPACE_METADATA_KEY]: input.space.spaceId },
    visibility: 'private',
    inSession: false,
    callerSessionId: null,
    idempotencyKey: input.key,
  });
  if (result.error) {
    logger.warn('[space-watch] the watcher session was not created', { space_id: input.space.spaceId, status: result.error.status });
    return null;
  }
  return result.row?.sessionId ?? result.sessionId ?? null;
}

/** The watcher's newest top-level posts in the space, newest first. */
async function ownPosts(spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ text: sql<string | null>`${projectSessions.metadata}->>${CHAT_ROOT_TEXT_KEY}` })
    .from(projectSessions)
    .where(and(
      eq(projectSessions.spaceId, spaceId),
      isNull(projectSessions.parentSessionId),
      sql`${projectSessions.metadata} ? ${WATCHER_POST_METADATA_KEY}`,
    ))
    .orderBy(desc(projectSessions.createdAt))
    .limit(OWN_POSTS_SHOWN);
  return rows.flatMap((row) => (row.text ? [row.text] : []));
}

async function readContext(place: { drive: DriveRow; folder: string } | null): Promise<string | null> {
  if (!place || !volumeOps().available()) return null;
  try {
    return (await volumeOps().read(place.drive, `${place.folder}/context.md`, { headBytes: 8_000 }))?.text ?? null;
  } catch {
    return null;
  }
}

/** `events.md` in the space folder: the newest lines. Best effort. */
async function writeEventsFile(place: { drive: DriveRow; folder: string } | null, space: SpaceRow): Promise<void> {
  if (!place || !volumeOps().available()) return;
  try {
    const text = eventsFileText(spacePlace(space), await latestLines(space.spaceId, EVENTS_FILE_LINES));
    await volumeOps().write(place.drive, `${place.folder}/events.md`, text, { overwrite: true });
  } catch (error) {
    logger.warn('[space-watch] events.md was not written', { space_id: space.spaceId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** The owner as the watcher reads them: their name and the exact `@` token that mentions them. */
async function ownerName(userId: string): Promise<string> {
  const who = (await resolveUserIdentities([userId])).get(userId);
  const name = who?.displayName?.trim() || who?.email?.split('@')[0] || 'the space owner';
  const token = await mentionOf(userId);
  return token ? `${name} (mention them as ${token})` : name;
}

/** One wake of one space. Returns the session it went to, or null. */
export async function wakeSpaceWatcher(candidate: WatchCandidate, reason: WakeReason, now: Date): Promise<{ sessionId: string; cursor: number; shown: number } | null> {
  const { watch, space } = candidate;
  const fresh = await eventsAfter(space.spaceId, watch.cursor, WAKE_EVENTS_MAX);
  const shown = reason === 'brief' ? await eventsSince(space.spaceId, new Date(now.getTime() - 86_400_000), WAKE_EVENTS_MAX) : fresh.rows;
  const cursor = Math.max(watch.cursor, ...fresh.rows.map((row) => row.eventId));
  const place = await spaceFolderFor(space).catch(() => null);
  await writeEventsFile(place, space);
  const text = wakePromptText({
    place: spacePlace(space),
    reason,
    owner: await ownerName(watch.ownerUserId),
    events: shown.map((row) => row.line),
    more: reason === 'brief' ? 0 : fresh.more,
    context: await readContext(place),
    ownPosts: await ownPosts(space.spaceId),
  });
  const project = await loadProject(space.projectId);
  if (!project) return null;
  const sessionId = await deliverWake({
    project,
    space,
    watch,
    text,
    key: `space-watch:${space.spaceId}:${reason}:${cursor}:${now.toISOString().slice(0, 16)}`,
  });
  return sessionId ? { sessionId, cursor, shown: shown.length } : null;
}

async function loadProject(projectId: string): Promise<ProjectRow | null> {
  const [row] = await db.select().from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  return row ?? null;
}

/** Record an urgent event for each ask open too long in a watched space. Returns the events written. */
export async function recordOverdueAsks(candidates: readonly WatchCandidate[], now: Date): Promise<number> {
  const watched = new Set(candidates.map((c) => c.space.spaceId));
  const watcherSessions = new Set(candidates.flatMap((c) => (c.watch.watcherSessionId ? [c.watch.watcherSessionId] : [])));
  const cutoff = now.getTime() - config.KORTIX_SPACE_WATCH_ASK_OVERDUE_MS;
  let written = 0;
  for (const projectId of new Set(candidates.map((c) => c.space.projectId))) {
    const asks = (await listOpenAsks({ projectId, limit: 200 })).filter(
      (ask) => ask.kind !== 'approval' && Date.parse(ask.asked_at) <= cutoff && !watcherSessions.has(ask.session_id),
    );
    if (asks.length === 0) continue;
    const threads = await spacesOfSessions([...new Set(asks.map((ask) => ask.surface_session_id))]);
    for (const ask of asks) {
      const thread = threads.get(ask.surface_session_id);
      if (!thread || !watched.has(thread.spaceId)) continue;
      const line = eventLine({ kind: 'ask_overdue', threadId: ask.surface_session_id, title: thread.title, ask: ask.title, askedAt: new Date(ask.asked_at) }, now);
      if (await recordSpaceEvent({ spaceId: thread.spaceId, kind: 'ask_overdue', line, dedupeKey: `ask:${ask.id}`, urgent: true })) written += 1;
    }
  }
  return written;
}

export interface SpaceWatcherTickResult {
  watchers: number;
  pruned: number;
  overdue: number;
  woken: number;
  skipped: Record<string, number>;
}

/** One tick of the `space-watcher` job. */
export async function runSpaceWatcherTick(now: Date = new Date()): Promise<SpaceWatcherTickResult> {
  const pruned = await pruneSpaceEvents(now);
  let candidates = await loadWatchCandidates(now);
  const result: SpaceWatcherTickResult = { watchers: candidates.length, pruned, overdue: 0, woken: 0, skipped: {} };
  if (candidates.length === 0) return result;
  result.overdue = await recordOverdueAsks(candidates, now);
  // An overdue ask just changed the counts: read them again.
  if (result.overdue > 0) candidates = await loadWatchCandidates(now);
  for (const candidate of candidates) {
    const { watch, space } = candidate;
    const decision = decideWake({
      now,
      state: {
        enabled: watch.enabled,
        dailyBrief: watch.dailyBrief,
        briefTimezone: watch.briefTimezone,
        lastWakeAt: watch.lastWakeAt,
        wakeDay: watch.wakeDay,
        wakesOnDay: watch.wakesOnDay,
        lastBriefOn: watch.lastBriefOn,
      },
      pending: { count: candidate.pending, urgent: candidate.urgent, lastDay: candidate.lastDay },
      debounceMs: config.KORTIX_SPACE_WATCH_DEBOUNCE_MS,
    });
    if (!decision.wake) {
      result.skipped[decision.reason] = (result.skipped[decision.reason] ?? 0) + 1;
      if (decision.reason === 'debounce' || decision.reason === 'budget') {
        logger.info('[space-watch] wake held', { space_id: space.spaceId, reason: decision.reason, pending: candidate.pending, wakes_today: watch.wakesOnDay });
      }
      continue;
    }
    try {
      const woke = await wakeSpaceWatcher(candidate, decision.reason, now);
      if (!woke) continue;
      await markWake({
        spaceId: space.spaceId,
        cursor: woke.cursor,
        at: now,
        utcDay: decision.utcDay,
        wakesOnDay: decision.wakesOnDay,
        briefOn: decision.reason === 'brief' ? decision.localDay : null,
        watcherSessionId: woke.sessionId,
      });
      result.woken += 1;
      logger.info('[space-watch] woke', {
        space_id: space.spaceId,
        session_id: woke.sessionId,
        reason: decision.reason,
        events: woke.shown,
        wakes_today: decision.wakesOnDay,
      });
      if (decision.budgetReached) {
        logger.warn('[space-watch] daily wake budget reached; no more wakes today (UTC)', { space_id: space.spaceId, wakes_today: decision.wakesOnDay });
      }
    } catch (error) {
      logger.warn('[space-watch] the wake failed', { space_id: space.spaceId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
