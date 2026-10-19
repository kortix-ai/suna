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

/**
 * Create the stream, or update the one that exists. A parked stream is armed
 * again (a re-subscribe is its retry) and records what is there first, like a
 * resumed pause: its triggers were not live, so that window is not owed. A
 * live stream keeps what it has seen, so nothing fires twice.
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
}): Promise<void> {
  await db
    .insert(polls)
    .values({ ...input, nextPollAt: sql`now()` })
    .onConflictDoUpdate({
      target: polls.externalId,
      set: {
        intervalSeconds: input.intervalSeconds,
        connectorSlug: input.connectorSlug,
        nextPollAt: sql`coalesce(${polls.nextPollAt}, now())`,
        primedAt: sql`case when ${polls.nextPollAt} is null then null else ${polls.primedAt} end`,
        fireAfter: sql`case when ${polls.nextPollAt} is null then ${RECORD_FIRST.toISOString()}::timestamptz else ${polls.fireAfter} end`,
        lastErrorKind: sql`case when ${polls.nextPollAt} is null then null else ${polls.lastErrorKind} end`,
        lastError: sql`case when ${polls.nextPollAt} is null then null else ${polls.lastError} end`,
        failures: sql`case when ${polls.nextPollAt} is null then 0 else ${polls.failures} end`,
        updatedAt: sql`now()`,
      },
    });
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
  const due = sql`(
    SELECT external_id FROM kortix.project_trigger_event_polls
     WHERE next_poll_at <= now()
       AND (locked_until IS NULL OR locked_until < now())
     ORDER BY next_poll_at
     LIMIT ${limit}
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
>>;

type Executor = Pick<typeof db, 'update'>;

/** Write a check's outcome and release the claim. False when another claim replaced this one. */
export async function settleStream(stream: PollStream, patch: StreamPatch, executor: Executor = db): Promise<boolean> {
  const done = await executor
    .update(polls)
    .set({ ...patch, lockedUntil: null, updatedAt: sql`now()` })
    .where(and(eq(polls.externalId, stream.externalId), eq(polls.claim, stream.claim)))
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
