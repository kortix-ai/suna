/**
 * The RUNTIME PROJECTION store — server-side custody of the daemon's
 * `/kortix/opencode/state` document.
 *
 * WHY IT EXISTS. Opening a session used to ask the box seven questions
 * (`/agent` `/command` `/config` `/session` `/session/status` `/permission`
 * `/question`): ~3.3 MB and ~1.4 s EACH across the edge hop — ~9.8 s serial,
 * every open, for facts that change once a boot. WS-Z1's daemon now projects
 * all seven into ONE ~8.7 KB document (0.9 KB gzipped, 0.1 ms warm in-VM).
 * This module keeps that document in Postgres so the read never leaves the
 * control plane — which is what lets a STOPPED session still answer "which
 * agents, which commands, what model" with zero sandbox hops.
 *
 * ─── IT IS A CACHE OF A FACT, NOT A FACT ───────────────────────────────────
 * `session-transcript-mirror.ts:34-38` states the rule this obeys: *a cached
 * record whose id the live read will not also produce is a ghost*. So the
 * identity the live read WOULD produce travels with the projection, and
 * {@link resolveRuntimeLeg} refuses to present a projection whose identity no
 * longer matches. An agent roster from a re-pinned OpenCode session is the same
 * defect as a ghost message, wearing different clothes.
 *
 * ─── WHICH IDENTITY CHECKS ARE APPLIED, AND WHICH ARE ONLY REPORTED ────────
 * Applied (free — both sides are already in hand):
 *   • `opencode_session_id` vs the session row's pin  → `identity_mismatch`
 *   • age vs {@link PROJECTION_MAX_AGE_MS}, and only while the sandbox is
 *     RUNNING                                          → `stale`
 * Reported, not gated:
 *   • `opencode_version`   — gating it needs the manifest pin resolved, which
 *     this path does not read.
 *   • `agent_config_etag`  — gating it needs a manifest COMPILE
 *     (`compile-agent-config.ts`), which is the ~500 ms of work the whole
 *     bundle exists to keep off the first paint. Both values are on the wire,
 *     so a caller that wants the stricter verdict can make it without this
 *     module guessing on its behalf.
 * This is a deliberate narrowing of DESIGN-V §6.6's four reasons to two, and
 * the two dropped ones are dropped for cost, not because they are wrong.
 *
 * ─── WHY A STOPPED BOX'S PROJECTION NEVER GOES STALE ───────────────────────
 * Age is evidence of a dead push loop, not of change. A stopped box cannot
 * change, so its projection is the last TRUE state and saying "unknown" there
 * is strictly worse than saying "as of 3 h ago".
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  projectSessions,
  sessionRuntimeProjections,
  sessionSandboxes,
} from '@kortix/db';
import { db } from '../../shared/db';

/**
 * How old a RUNNING box's projection may be before it is refused.
 *
 * Six hours: the projection is refreshed on change, so age this large means the
 * refresh path itself is dead. Long enough that a healthy box never trips it,
 * short enough that a silently broken relay is caught inside one working day.
 */
export const PROJECTION_MAX_AGE_MS = 6 * 60 * 60_000;

/** Sandbox statuses that mean "this box could be answering right now". */
const RUNNING_SANDBOX_STATUSES = new Set(['provisioning', 'active']);

/** Largest projection body accepted from the daemon, decompressed. */
export const PROJECTION_MAX_BYTES = 256 * 1024;

export type RuntimeProjectionSource = 'daemon_push' | 'api_pull';

/** Identity the live runtime would also produce. See the ghost rule above. */
export interface RuntimeProjectionIdentity {
  opencode_session_id: string | null;
  opencode_version: string | null;
  daemon_build: number | null;
  agent_config_etag: string | null;
  head_seq: Record<string, number> | null;
}

export interface StoredRuntimeProjection {
  sessionId: string;
  projectId: string;
  accountId: string;
  externalId: string;
  identity: RuntimeProjectionIdentity;
  epoch: string | null;
  seq: number | null;
  projectionEtag: string;
  projection: Record<string, unknown>;
  source: RuntimeProjectionSource;
  capturedAt: Date;
}

export type RuntimeLegReason = 'no_projection' | 'identity_mismatch' | 'stale';

/**
 * The `runtime` leg of `open-bundle`, tri-state exactly like its siblings.
 *
 * `known: false` renders UNKNOWN — never an empty agent roster. An empty
 * roster presented as fact is the defect class the whole bundle exists to
 * remove, and a projection must not re-introduce it under a new name.
 */
export type RuntimeLeg =
  | { known: false; reason: RuntimeLegReason }
  | {
      known: true;
      /** identity matched AND (the box is stopped OR age < the max). */
      fresh: boolean;
      /** Who wrote the row this was served from. */
      source: RuntimeProjectionSource;
      captured_at: string;
      age_ms: number;
      /** `false` when the sandbox row says the box is not running. */
      runtime_running: boolean;
      /** The daemon stream cursor at capture — hand these to `?epoch=&since=`. */
      epoch: string | null;
      seq: number | null;
      identity: RuntimeProjectionIdentity;
      /** The `/kortix/opencode/state` document, verbatim. */
      state: Record<string, unknown>;
    };

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pull the identity out of a `/kortix/opencode/state` document.
 *
 * Tolerant on purpose: the daemon owns this shape and a future field must not
 * make an older API refuse a projection it can still serve.
 */
export function projectionIdentity(doc: unknown): RuntimeProjectionIdentity {
  const identity =
    doc && typeof doc === 'object'
      ? ((doc as Record<string, unknown>).identity as Record<string, unknown> | undefined)
      : undefined;
  const headSeq = identity?.head_seq;
  return {
    opencode_session_id: asString(identity?.opencode_session_id),
    opencode_version: asString(identity?.opencode_version),
    daemon_build: asNumber(identity?.daemon_build),
    agent_config_etag: asString(identity?.agent_config_etag),
    head_seq:
      headSeq && typeof headSeq === 'object' && !Array.isArray(headSeq)
        ? (headSeq as Record<string, number>)
        : null,
  };
}

export interface SaveRuntimeProjectionInput {
  sessionId: string;
  projectId: string;
  accountId: string;
  externalId: string;
  projectionEtag: string;
  projection: Record<string, unknown>;
  capturedAt: Date;
  source: RuntimeProjectionSource;
}

/**
 * Upsert one session's projection. Last write wins on the session id.
 *
 * A warm-fork adoption can briefly leave two daemons believing they own a
 * session; the `external_id` column names the one whose write landed last, so
 * there is one row and one truth rather than a silent merge.
 *
 * Returns `'ignored'` when a NEWER capture is already stored — the guard that
 * stops an out-of-order retry from overwriting fresher truth.
 */
/**
 * The out-of-order guard, as a raw `sql` fragment: only overwrite when the
 * stored capture is not newer than this one. Bind an ISO string with an
 * explicit `::timestamptz` cast, NOT the raw Date — in a raw `sql` fragment
 * postgres-js serializes a JS Date with its locale `toString()`
 * ("Thu Aug 27 2026 03:01:29 GMT+0200 (CEST)"), which Postgres cannot parse as
 * a timestamp, so every real push 500'd here while the mocked-db unit test
 * never ran the SQL. Exported so a unit test can pin the compiled parameter.
 */
export function capturedAtNotNewerThan(capturedAt: Date) {
  return sql`${sessionRuntimeProjections.capturedAt} <= ${capturedAt.toISOString()}::timestamptz`;
}

export async function saveRuntimeProjection(
  input: SaveRuntimeProjectionInput,
): Promise<'stored' | 'ignored'> {
  const identity = projectionIdentity(input.projection);
  const epoch = asString((input.projection as Record<string, unknown>).epoch);
  const seq = asNumber((input.projection as Record<string, unknown>).seq);

  const result = await db
    .insert(sessionRuntimeProjections)
    .values({
      sessionId: input.sessionId,
      projectId: input.projectId,
      accountId: input.accountId,
      externalId: input.externalId,
      opencodeSessionId: identity.opencode_session_id,
      opencodeVersion: identity.opencode_version,
      agentConfigEtag: identity.agent_config_etag,
      daemonBuild: identity.daemon_build,
      epoch,
      seq,
      headSeq: identity.head_seq ?? undefined,
      projectionEtag: input.projectionEtag,
      projection: input.projection,
      source: input.source,
      capturedAt: input.capturedAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sessionRuntimeProjections.sessionId,
      set: {
        externalId: input.externalId,
        opencodeSessionId: identity.opencode_session_id,
        opencodeVersion: identity.opencode_version,
        agentConfigEtag: identity.agent_config_etag,
        daemonBuild: identity.daemon_build,
        epoch,
        seq,
        headSeq: identity.head_seq ?? null,
        projectionEtag: input.projectionEtag,
        projection: input.projection,
        source: input.source,
        capturedAt: input.capturedAt,
        updatedAt: new Date(),
      },
      // An OUT-OF-ORDER push must not win. Two daemons can briefly both believe
      // they own a session (warm-fork adoption), and a retry ladder can deliver
      // an older capture after a newer one; without this guard the loser's
      // retry would overwrite the winner's state. `<=` and not `<` so a repeat
      // of the SAME capture is idempotent rather than refused. The ISO+cast
      // binding lives in capturedAtNotNewerThan — the raw-Date form 500'd.
      setWhere: capturedAtNotNewerThan(input.capturedAt),
    })
    .returning({ etag: sessionRuntimeProjections.projectionEtag });

  return result.length > 0 ? 'stored' : 'ignored';
}

export interface RuntimeProjectionRead {
  row: StoredRuntimeProjection | null;
  /** The session's current OpenCode pin, for the identity check. */
  pinnedOpencodeSessionId: string | null;
  /** Whether a sandbox row says this session's box could be answering. */
  runtimeRunning: boolean;
}

/**
 * ONE query for the projection AND the two facts its verdict needs.
 *
 * A LEFT JOIN rather than three reads: the freshness rule depends on whether
 * the box is running, and paying a second round trip to learn that would
 * re-introduce the serial-read cost this whole design deletes.
 */
export async function readRuntimeProjection(
  sessionId: string,
): Promise<RuntimeProjectionRead> {
  const rows = await db
    .select({
      sessionId: sessionRuntimeProjections.sessionId,
      projectId: sessionRuntimeProjections.projectId,
      accountId: sessionRuntimeProjections.accountId,
      externalId: sessionRuntimeProjections.externalId,
      opencodeSessionId: sessionRuntimeProjections.opencodeSessionId,
      opencodeVersion: sessionRuntimeProjections.opencodeVersion,
      agentConfigEtag: sessionRuntimeProjections.agentConfigEtag,
      daemonBuild: sessionRuntimeProjections.daemonBuild,
      epoch: sessionRuntimeProjections.epoch,
      seq: sessionRuntimeProjections.seq,
      headSeq: sessionRuntimeProjections.headSeq,
      projectionEtag: sessionRuntimeProjections.projectionEtag,
      projection: sessionRuntimeProjections.projection,
      source: sessionRuntimeProjections.source,
      capturedAt: sessionRuntimeProjections.capturedAt,
      pinned: projectSessions.opencodeSessionId,
      sandboxStatus: sessionSandboxes.status,
    })
    .from(projectSessions)
    .leftJoin(
      sessionRuntimeProjections,
      eq(sessionRuntimeProjections.sessionId, projectSessions.sessionId),
    )
    .leftJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, projectSessions.sessionId))
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return { row: null, pinnedOpencodeSessionId: null, runtimeRunning: false };

  return {
    row: row.projectionEtag
      ? {
          sessionId: row.sessionId!,
          projectId: row.projectId!,
          accountId: row.accountId!,
          externalId: row.externalId!,
          identity: {
            opencode_session_id: row.opencodeSessionId ?? null,
            opencode_version: row.opencodeVersion ?? null,
            daemon_build: row.daemonBuild ?? null,
            agent_config_etag: row.agentConfigEtag ?? null,
            head_seq: (row.headSeq as Record<string, number> | null) ?? null,
          },
          epoch: row.epoch ?? null,
          seq: row.seq ?? null,
          projectionEtag: row.projectionEtag,
          projection: row.projection as Record<string, unknown>,
          source: (row.source as RuntimeProjectionSource) ?? 'api_pull',
          capturedAt: row.capturedAt!,
        }
      : null,
    pinnedOpencodeSessionId: row.pinned ?? null,
    runtimeRunning: RUNNING_SANDBOX_STATUSES.has(String(row.sandboxStatus ?? '')),
  };
}

/**
 * Turn a stored projection into the bundle's `runtime` leg.
 *
 * PURE — takes the read, returns the verdict. Every rule above is decided here
 * and nowhere else, so the stream and the bundle can never present two
 * different verdicts about the same row.
 */
export function resolveRuntimeLeg(
  read: RuntimeProjectionRead,
  nowMs: number = Date.now(),
): RuntimeLeg {
  const { row, pinnedOpencodeSessionId, runtimeRunning } = read;
  if (!row) return { known: false, reason: 'no_projection' };

  // Both sides must be known before a mismatch is a mismatch. A session with no
  // pin yet (a cold box mid-boot) is not evidence that the projection is wrong.
  if (
    pinnedOpencodeSessionId &&
    row.identity.opencode_session_id &&
    pinnedOpencodeSessionId !== row.identity.opencode_session_id
  ) {
    return { known: false, reason: 'identity_mismatch' };
  }

  const ageMs = Math.max(0, nowMs - row.capturedAt.getTime());
  if (runtimeRunning && ageMs > PROJECTION_MAX_AGE_MS) {
    return { known: false, reason: 'stale' };
  }

  return {
    known: true,
    fresh: !runtimeRunning || ageMs <= PROJECTION_MAX_AGE_MS,
    source: row.source,
    captured_at: row.capturedAt.toISOString(),
    age_ms: ageMs,
    runtime_running: runtimeRunning,
    epoch: row.epoch,
    seq: row.seq,
    identity: row.identity,
    state: row.projection,
  };
}

/** Read + verdict in one call — what `open-bundle` uses. */
export async function readRuntimeLeg(
  sessionId: string,
  nowMs: number = Date.now(),
): Promise<RuntimeLeg> {
  return resolveRuntimeLeg(await readRuntimeProjection(sessionId), nowMs);
}

/**
 * Delete a session's projection — used when a re-pin makes it unreachable.
 *
 * Not called from the read path: a mismatched projection is REFUSED by
 * {@link resolveRuntimeLeg}, and refusing is enough. Deleting on read would
 * make a transient pin disagreement destroy a row the next push would have
 * corrected.
 */
export async function deleteRuntimeProjection(sessionId: string): Promise<void> {
  await db
    .delete(sessionRuntimeProjections)
    .where(and(eq(sessionRuntimeProjections.sessionId, sessionId)));
}
