/** Poll streams of the `mcp` event source (`kortix.project_trigger_event_polls`). */
import { projectTriggerEventPolls as polls, projectTriggerEventSubscriptions as subs } from '@kortix/db';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { canonicalJson } from './canonical-json';

export type PollStream = typeof polls.$inferSelect;

/**
 * `fire_after` of a stream that must record before it fires again (a pause, a
 * park): its next check fires nothing, then `fire_after` becomes that check's time.
 */
export const RECORD_FIRST = new Date('9999-12-31T00:00:00Z');
export type PollErrorKind = 'needs_connection' | 'fatal' | 'transient';

/** At most this many streams per project: each costs one vendor call per interval. */
export const MAX_STREAMS_PER_PROJECT = 50;

/**
 * Same account, event and config → same stream: triggers that watch the same
 * thing share one vendor read, and a re-subscribe after an error keeps what
 * the stream has seen. The interval is not part of the id.
 */
export function streamIdFor(connectionId: string, eventType: string, config: Record<string, unknown>): string {
  const digest = createHash('sha256').update(canonicalJson(['mcp-poll/v1', connectionId, eventType, config])).digest('hex');
  return `mcp_${digest.slice(0, 32)}`;
}

export async function getStream(externalId: string): Promise<PollStream | null> {
  const [row] = await db.select().from(polls).where(eq(polls.externalId, externalId)).limit(1);
  return row ?? null;
}

export async function countStreams(projectId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(polls).where(eq(polls.projectId, projectId));
  return row?.n ?? 0;
}

/** Transient failures in a row before the triggers show the stream's error. Checks continue. */
export const FAILURES_BEFORE_ROW_ERROR = 3;

/** A person must act (sign in again, fix a setting): the stream retries on its own only hourly. */
export const isParked = (stream: Pick<PollStream, 'lastErrorKind'>): boolean =>
  stream.lastErrorKind === 'needs_connection' || stream.lastErrorKind === 'fatal';

/**
 * Create the stream, or update the one that exists. `rearm` (a parked stream
 * whose account changed since it parked) checks at once and records what is
 * there first: its triggers were not live, so that window is not owed. It also
 * takes the claim, so a check still running cannot park it again. A failing
 * stream that is not re-armed keeps its schedule (the hourly park retry, or
 * the backoff and Retry-After): the connector sweep re-subscribes failing
 * triggers every few minutes, and that must not call the vendor each time. A
 * healthy stream keeps what it has seen, and a shorter interval pulls its next
 * check in.
 */
export async function upsertStream(input: {
  externalId: string;
  projectId: string;
  accountId: string;
  connectionId: string;
  connectorSlug: string;
  eventType: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
}, rearm = false): Promise<void> {
  const set = rearm
    ? {
        nextPollAt: sql`now()`,
        primedAt: null,
        fireAfter: RECORD_FIRST,
        lastErrorKind: null,
        lastError: null,
        failures: 0,
        claim: sql`${polls.claim} + 1`,
        lockedUntil: null,
      }
    : {
        nextPollAt: sql`case when ${polls.failures} > 0 then ${polls.nextPollAt}
          else least(coalesce(${polls.nextPollAt}, now()), now() + make_interval(secs => ${input.intervalSeconds})) end`,
      };
  await db
    .insert(polls)
    .values({ ...input, nextPollAt: sql`now()` })
    .onConflictDoUpdate({
      target: polls.externalId,
      set: { ...set, intervalSeconds: input.intervalSeconds, connectorSlug: input.connectorSlug, updatedAt: sql`now()` },
    });
}

/** When each stream last checked with success and checks next, by external id. One query. */
export async function streamSchedules(
  externalIds: readonly string[],
): Promise<Map<string, { checkedAt: Date | null; nextCheckAt: Date | null; lastError: string | null }>> {
  if (externalIds.length === 0) return new Map();
  const rows = await db
    .select({ externalId: polls.externalId, lastSuccessAt: polls.lastSuccessAt, nextPollAt: polls.nextPollAt, lastError: polls.lastError })
    .from(polls)
    .where(inArray(polls.externalId, [...externalIds]));
  return new Map(rows.map((r) => [r.externalId, { checkedAt: r.lastSuccessAt, nextCheckAt: r.nextPollAt, lastError: r.lastError }]));
}

/** Idempotent. */
export async function deleteStream(externalId: string): Promise<void> {
  await db.delete(polls).where(eq(polls.externalId, externalId));
}

/**
 * Claim up to `limit` due streams for `leaseMs`. Every claim bumps `claim`;
 * only the holder of the current claim can settle (see `settleStream`).
 */
export async function claimDueStreams(limit: number, leaseMs: number): Promise<PollStream[]> {
  // Fair across projects: at most 2 per project per claim, none for a project with 2 checks
  // running, so one project's slow MCP server cannot hold every slot.
  const due = sql`(
    SELECT external_id FROM kortix.project_trigger_event_polls
     WHERE external_id IN (
       SELECT external_id FROM (
         SELECT p.external_id, p.next_poll_at,
                row_number() OVER (PARTITION BY p.project_id ORDER BY p.next_poll_at) AS rn
           FROM kortix.project_trigger_event_polls p
          WHERE p.next_poll_at <= now()
            AND (p.locked_until IS NULL OR p.locked_until < now())
            AND (SELECT count(*) FROM kortix.project_trigger_event_polls r
                  WHERE r.project_id = p.project_id AND r.locked_until > now()) < 2
       ) d
        WHERE d.rn <= 2
        ORDER BY d.next_poll_at
        LIMIT ${limit})
       AND next_poll_at <= now()
       AND (locked_until IS NULL OR locked_until < now())
     ORDER BY next_poll_at
     FOR UPDATE SKIP LOCKED)`;
  return db
    .update(polls)
    .set({
      lockedUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
      claim: sql`${polls.claim} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(polls.externalId, due))
    .returning();
}

export type StreamPatch = Partial<Pick<
  PollStream,
  | 'seen'
  | 'primedAt'
  | 'fireAfter'
  | 'intervalSeconds'
  | 'nextPollAt'
  | 'failures'
  | 'lastError'
  | 'lastErrorKind'
  | 'rateWindowStart'
  | 'rateWindowFires'
  | 'lastSuccessAt'
  | 'updatedAt'
>>;

type Executor = Pick<typeof db, 'update'>;

/**
 * Write a check's outcome and release the claim. False when another claim
 * replaced this one, or the stream was deleted and created again (its
 * `claim` restarts at 0, so the creation time is part of the fence).
 */
export async function settleStream(stream: PollStream, patch: StreamPatch, executor: Executor = db): Promise<boolean> {
  const done = await executor
    .update(polls)
    .set({ lockedUntil: null, updatedAt: sql`now()`, ...patch })
    .where(and(
      eq(polls.externalId, stream.externalId),
      eq(polls.claim, stream.claim),
      sql`date_trunc('milliseconds', ${polls.createdAt}) = ${stream.createdAt.toISOString()}::timestamptz`,
    ))
    .returning({ externalId: polls.externalId });
  return done.length > 0;
}

/** A 429 slows every stream of the account, not only the one that saw it. */
export async function delayConnectionStreams(connectionId: string, until: Date): Promise<void> {
  await db
    .update(polls)
    .set({ nextPollAt: sql`greatest(${polls.nextPollAt}, ${until.toISOString()}::timestamptz)` })
    .where(and(eq(polls.connectionId, connectionId), sql`${polls.nextPollAt} is not null`));
}

/** The triggers subscribed to a stream. */
export async function streamRows(externalId: string) {
  return db
    .select()
    .from(subs)
    .where(and(eq(subs.provider, 'mcp'), eq(subs.externalId, externalId)));
}

/**
 * A failure below the threshold on a stream whose triggers already show its
 * error: they show the new one, so they stay matched to the stream (the poll
 * serves triggers whose error is the stream's own). Status unchanged.
 */
export async function carryRowsError(externalId: string, previousError: string, lastError: string): Promise<void> {
  await db
    .update(subs)
    .set({ lastError, updatedAt: new Date() })
    .where(and(eq(subs.provider, 'mcp'), eq(subs.externalId, externalId), eq(subs.lastError, previousError)));
}

/**
 * The stream's health onto its triggers. The poll touches only rows it may
 * speak for: `active` rows, and rows that carry the stream's own earlier
 * error (`previousError`). A row the reconciler failed (a refused subscribe
 * keeps its old stream id) keeps the reconciler's error. Returns the rows
 * that changed.
 */
export async function setRowsStatus(
  externalId: string,
  status: 'active' | 'needs_connection' | 'error',
  lastError: string | null,
  previousError: string | null,
  executor: Pick<typeof db, 'update'> = db,
): Promise<Array<{ projectId: string; slug: string; accountId: string }>> {
  const ownError = previousError === null ? sql`false` : sql`${subs.lastError} = ${previousError}`;
  const from = status === 'active'
    ? sql`(${subs.status} <> 'active' and ${ownError})`
    : sql`((${subs.status} = 'active' or ${ownError}) and (${subs.status} <> ${status} or ${subs.lastError} is distinct from ${lastError}))`;
  return executor
    .update(subs)
    .set({ status, lastError, updatedAt: new Date() })
    .where(and(eq(subs.provider, 'mcp'), eq(subs.externalId, externalId), from))
    .returning({ projectId: subs.projectId, slug: subs.slug, accountId: subs.accountId });
}
