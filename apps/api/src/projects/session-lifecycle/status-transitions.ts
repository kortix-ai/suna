/**
 * The status writes of the session lifecycle: `project_sessions.status` and
 * `session_sandboxes.status`.
 *
 * Each status change is a NAMED transition with a fixed set of states it may
 * leave. A transition is ONE guarded UPDATE:
 *
 *   - `status IN (from)`, from the table below;
 *   - for a session, the tombstone: a deleted session (`metadata.deletedAt`) is
 *     never moved, unless the transition is one a deleted session still makes;
 *     for a sandbox, a deleted session's row is `archived`, and only the
 *     archive transitions accept or produce that state;
 *   - the caller's own compare-and-set predicate (`guard`): an external id, a
 *     lease id, a row version.
 *
 * It returns whether it applied. Sandbox metadata is only ever stripped and
 * merged in SQL, from the row the UPDATE locks. A whole metadata object built
 * from an earlier read erases every key a concurrent writer added since (the
 * wake fence, `lastAliveAt`, the egress pin), so this module has no way to
 * write one.
 */

import {
  type Database,
  projectSessionStatusEnum,
  projectSessions,
  sessionSandboxStatusEnum,
  sessionSandboxes,
} from '@kortix/db';
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '../../shared/db';
import { ACTIVE_SESSION_STATUSES } from '../lib/session-status';
import { stripMetadataKeys } from './sandbox-metadata-sql';

export type SessionStatus = (typeof projectSessionStatusEnum.enumValues)[number];
export type SandboxStatus = (typeof sessionSandboxStatusEnum.enumValues)[number];

const ANY_SESSION: readonly SessionStatus[] = projectSessionStatusEnum.enumValues;
const ANY_SANDBOX: readonly SandboxStatus[] = sessionSandboxStatusEnum.enumValues;
/** Every sandbox status except the deleted session's `archived`. */
const LIVE_SANDBOX: readonly SandboxStatus[] = ANY_SANDBOX.filter((s) => s !== 'archived');

interface SessionTransitionRule {
  from: readonly SessionStatus[];
  to: SessionStatus;
  /** Also applies to a deleted session. Only transitions TOWARD stopped may. */
  appliesToDeleted?: true;
}

interface SandboxTransitionRule {
  from: readonly SandboxStatus[];
  to: SandboxStatus;
}

export const SESSION_TRANSITIONS = {
  /** `deleteSession`: the write that tombstones the session. */
  delete: { from: ANY_SESSION, to: 'stopped', appliesToDeleted: true },
  /**
   * The box parked (`applyStoppedState`). A `failed` session keeps its park:
   * the dead-letter sets it so a `session_mode: "reuse"` trigger's next fire
   * creates a fresh session instead of aiming at a wedged one.
   */
  stop: {
    from: ANY_SESSION.filter((s) => s !== 'failed'),
    to: 'stopped',
    appliesToDeleted: true,
  },
  /** `reconcileStuckActiveSessions`: an active status with no live box behind it. */
  reconcileStuck: { from: ACTIVE_SESSION_STATUSES, to: 'stopped', appliesToDeleted: true },
  /** A trigger delivery dead-lettered (`markCommandFailed`). */
  fail: { from: ANY_SESSION.filter((s) => s !== 'failed'), to: 'failed' },
  /** `continueSession` wakes a parked session before it delivers a prompt. */
  wake: { from: ['stopped', 'completed'], to: 'running' },
  /** A runtime is being provisioned, restarted, or recovered. */
  provision: { from: ANY_SESSION, to: 'provisioning' },
  /** A restart, recovery, or stalled provisioning finished with the box running. */
  resume: { from: ANY_SESSION, to: 'running' },
  /** The runtime stopped for a reason of its own: lost, parked, failed restart. */
  park: { from: ANY_SESSION, to: 'stopped' },
} as const satisfies Record<string, SessionTransitionRule>;

export const SANDBOX_TRANSITIONS = {
  /** `deleteSession`. */
  archive: { from: ANY_SANDBOX, to: 'archived' },
  /** A `provisioning` row of a deleted session whose owner lapsed. */
  archiveProvisioning: { from: ['provisioning'], to: 'archived' },
  /** A restart or recovery claimed the row. */
  provision: { from: LIVE_SANDBOX, to: 'provisioning' },
  /** A restart or recovery finished with the box running. */
  activate: { from: LIVE_SANDBOX, to: 'active' },
  /** A `provisioning` row whose owner lapsed, and the provider says the box runs. */
  activateProvisioning: { from: ['provisioning'], to: 'active' },
  /** The box stopped: idle, user Stop, provider report, lost, failed restart. */
  stop: { from: LIVE_SANDBOX, to: 'stopped' },
  /** A live box parked after a failed start (`parkEstablishedRuntime`). */
  park: { from: ['active'], to: 'stopped' },
} as const satisfies Record<string, SandboxTransitionRule>;

export type SessionTransition = keyof typeof SESSION_TRANSITIONS;
export type SandboxTransition = keyof typeof SANDBOX_TRANSITIONS;

export type SessionSandboxRow = typeof sessionSandboxes.$inferSelect;

/** A database handle or an open transaction. */
type Executor = Pick<Database, 'update'>;

/** Keys to remove from, and keys to merge into, the sandbox metadata. */
export interface SandboxMetadataPatch {
  strip?: readonly string[];
  merge?: Record<string, unknown>;
}

interface SessionWrite {
  /** Written as `updated_at`. Defaults to now. */
  at?: Date;
  /** Set `error` (a message, or null to clear it). Omitted: left unchanged. */
  error?: string | null;
  /** Clear `sandbox_url`. */
  clearSandboxUrl?: true;
  /** Keys merged into the session metadata. */
  metadata?: Record<string, unknown>;
  /** The caller's own compare-and-set predicate, ANDed into the WHERE. */
  guard?: SQL;
}

interface SandboxWrite {
  at?: Date;
  metadata?: SandboxMetadataPatch;
  guard?: SQL;
}

/** A session `metadata.deletedAt` has not tombstoned. */
function sessionNotDeleted(): SQL {
  return sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`;
}

function statusIn<S extends string>(
  column: typeof projectSessions.status | typeof sessionSandboxes.status,
  from: readonly S[],
  every: readonly S[],
): SQL | undefined {
  // `IN (every value)` holds for every row: say nothing instead.
  if (every.every((status) => from.includes(status))) return undefined;
  return inArray(column, from as S[] as never[]);
}

function mergedSessionMetadata(patch: Record<string, unknown>): SQL {
  return sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

function patchedSandboxMetadata(patch: SandboxMetadataPatch): SQL {
  const stripped = stripMetadataKeys(patch.strip ?? []);
  if (!patch.merge || Object.keys(patch.merge).length === 0) return stripped;
  return sql`(${stripped}) || ${JSON.stringify(patch.merge)}::jsonb`;
}

/** Does `transition` leave a session in `status`? For a caller's pre-check. */
export function sessionTransitionLeaves(
  transition: SessionTransition,
  status: SessionStatus,
): boolean {
  return (SESSION_TRANSITIONS[transition].from as readonly SessionStatus[]).includes(status);
}

/** Apply a session transition. True when it moved the row. */
export async function transitionSession(
  transition: SessionTransition,
  sessionId: string,
  write: SessionWrite = {},
  exec: Executor = db,
): Promise<boolean> {
  const rule: SessionTransitionRule = SESSION_TRANSITIONS[transition];
  const [moved] = await exec
    .update(projectSessions)
    .set({
      status: rule.to,
      updatedAt: write.at ?? new Date(),
      ...(write.error !== undefined ? { error: write.error } : {}),
      ...(write.clearSandboxUrl ? { sandboxUrl: null } : {}),
      ...(write.metadata ? { metadata: mergedSessionMetadata(write.metadata) } : {}),
    })
    .where(
      and(
        eq(projectSessions.sessionId, sessionId),
        statusIn(projectSessions.status, rule.from, ANY_SESSION),
        rule.appliesToDeleted ? undefined : sessionNotDeleted(),
        write.guard,
      ),
    )
    .returning({ sessionId: projectSessions.sessionId });
  return Boolean(moved);
}

/** Apply a sandbox transition. The moved row, or null when it did not apply. */
export async function transitionSandbox(
  transition: SandboxTransition,
  sandboxId: string,
  write: SandboxWrite = {},
  exec: Executor = db,
): Promise<SessionSandboxRow | null> {
  const rule: SandboxTransitionRule = SANDBOX_TRANSITIONS[transition];
  const [moved] = await exec
    .update(sessionSandboxes)
    .set({
      status: rule.to,
      updatedAt: write.at ?? new Date(),
      ...(write.metadata ? { metadata: patchedSandboxMetadata(write.metadata) } : {}),
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        statusIn(sessionSandboxes.status, rule.from, ANY_SANDBOX),
        write.guard,
      ),
    )
    .returning();
  return moved ?? null;
}

class RuntimeTransitionLost extends Error {}

type RuntimeTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Move a session and its sandbox together: both writes land, or neither does.
 *
 * The session write goes first, so a deleted session refuses before the
 * sandbox row is touched. A sandbox write that loses its compare-and-set rolls
 * the session write back. `then` runs in the same transaction once both
 * applied: a ledger settle, for example, that must be durable with the stop.
 */
export async function transitionRuntime(input: {
  sessionId: string;
  sandboxId: string;
  session: SessionTransition;
  sandbox: SandboxTransition;
  at: Date;
  error?: string | null;
  metadata?: SandboxMetadataPatch;
  guard?: SQL;
  then?: (tx: RuntimeTransaction, row: SessionSandboxRow) => Promise<void>;
}): Promise<SessionSandboxRow | null> {
  try {
    return await db.transaction(async (tx) => {
      const sessionMoved = await transitionSession(
        input.session,
        input.sessionId,
        { at: input.at, ...(input.error !== undefined ? { error: input.error } : {}) },
        tx,
      );
      if (!sessionMoved) return null;
      const row = await transitionSandbox(
        input.sandbox,
        input.sandboxId,
        { at: input.at, metadata: input.metadata, guard: input.guard },
        tx,
      );
      if (!row) throw new RuntimeTransitionLost();
      await input.then?.(tx, row);
      return row;
    });
  } catch (error) {
    if (error instanceof RuntimeTransitionLost) return null;
    throw error;
  }
}
