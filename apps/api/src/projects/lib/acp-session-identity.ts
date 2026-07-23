import { and, eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import type { Database } from '@kortix/db';

/**
 * The grounding invariant (docs/superpowers/plans/2026-07-15-cortex-cycle-plan.md):
 *
 *   RuntimeSessionIdentity = {
 *     projectSessionId  // durable Kortix identity — the `projectSessions` row id
 *                        // (== the `project_sessions.session_id` PRIMARY KEY).
 *                        // Survives sandbox replacement. NEVER re-minted here.
 *     runtimeId         // the CURRENT sandbox/runtime allocation. What this
 *                        // actually IS differs by call site today — interactive
 *                        // (`routes/acp.ts`'s `resolveAcpTarget`) sets it to the
 *                        // Kortix `sessionId` itself; headless (`engine.ts`) sets
 *                        // it to the daemon-reported ACP server id
 *                        // (`runtimeHealth.acpServerId`, `routes/shared.ts`).
 *                        // This module does not unify that — it is pinned AS-IS.
 *     acpSessionId       // harness-native, minted by `session/new` or confirmed
 *                        // by `session/load`. Independent random ID namespace —
 *                        // never derived from `projectSessionId`/`runtimeId`.
 *   }
 *
 * — never overload any of these into the sandbox id (`session_sandboxes.external_id`,
 * a THIRD, unrelated identifier). This module is the one place that WRITES the
 * triple's harness-facing two fields (`runtime_protocol` + `acp_session_id`,
 * alongside `runtime_id`) into `projectSessions.metadata`. Before this module
 * existed, `routes/acp.ts` (interactive) and `session-lifecycle/engine.ts`
 * (headless) each hand-rolled an identical read-merge-write — see
 * `packages/sdk/src/react/use-canonical-runtime-session.ts`'s doc comment for
 * the "session replaced / data lost" drift bug that class of duplication
 * caused historically on the READ side; this closes the equivalent WRITE-side
 * duplication.
 */
export type RuntimeSessionIdentity = {
  /** Durable — the `projectSessions` row id. Never overwritten by this module. */
  projectSessionId: string;
  /** Current sandbox/runtime allocation. Meaning varies by call site; pinned AS-IS. */
  runtimeId: string;
  /** Harness-native, minted by `session/new` | confirmed by `session/load`. */
  acpSessionId: string;
};

export type PersistAcpSessionIdentityDeps = {
  db: Database;
};

export type PersistAcpSessionIdentityOpts = {
  /**
   * Extra WHERE-clause scoping some call sites apply on top of
   * `projectSessionId`. `projectSessions.sessionId` is already the table's
   * PRIMARY KEY, so this can never change which row is matched — it is
   * preserved purely for byte-identical query-shape parity with the
   * pre-extraction interactive site (`routes/acp.ts`'s `resolveAcpTarget`
   * already loaded `projectId` off the URL, so it scoped both). The headless
   * site (`engine.ts`) never passed this and continues not to.
   */
  projectId?: string;
};

/**
 * Thrown when a caller attempts to persist `acpSessionId === runtimeId` — the
 * exact overload class the grounding invariant forbids: the harness-native ACP
 * session id collapsing onto the sandbox-scoped runtime id, which would make
 * two of the three distinct identities indistinguishable in persisted state.
 *
 * Why this is safe to THROW (not silently log-and-persist) for real traffic:
 * both current call sites source `acpSessionId` exclusively from the ACP
 * harness's `session/new` RPC response (`result.sessionId`) or its own
 * `session/load` echo — a value minted server-side by the harness process,
 * never seeded from or equal to our own `runtimeId` (a Kortix `randomUUID()`
 * session id, or the daemon-reported ACP server id — see `RuntimeSessionIdentity`
 * doc above). These are independent random-ID namespaces with no code path
 * that copies one into the other, so `acpSessionId === runtimeId` cannot occur
 * for a legitimately-behaving harness; it only occurs if a caller's plumbing
 * bug hands this function the wrong value. THIS GUARD ONLY RUNS AT WRITE TIME —
 * it never reads or validates already-persisted rows, so it is provably
 * incapable of breaking any existing session's stored metadata, including any
 * historical row that might (implausibly) already carry equal values.
 */
export class AcpSessionIdentityOverloadError extends Error {
  constructor(identity: RuntimeSessionIdentity) {
    super(
      `persistAcpSessionIdentity: refusing to persist acpSessionId === runtimeId ` +
      `("${identity.acpSessionId}") for projectSessionId ${identity.projectSessionId} — ` +
      `this is the overload class RuntimeSessionIdentity forbids (a harness-native ` +
      `acpSessionId collapsed onto the sandbox-scoped runtimeId). If this fires for ` +
      `real traffic, the guard's assumption is wrong — see the doc comment on this class.`,
    );
    this.name = 'AcpSessionIdentityOverloadError';
  }
}

/**
 * The ONE write path for ACP session identity onto `projectSessions.metadata`.
 * Both the interactive route (`routes/acp.ts`, on the `session/new` RESPONSE)
 * and the headless engine (`session-lifecycle/engine.ts`, on first mint before
 * `session/prompt`) call this. Behavior-frozen from the pre-extraction call
 * sites: read current metadata, spread it, overwrite exactly
 * `{ runtime_protocol: 'acp', runtime_id, acp_session_id }`, bump `updatedAt`.
 * No other persisted field is touched — `projectSessionId` (the row's PK) is
 * never part of the SET payload, so it can never be overwritten by this path.
 */
export async function persistAcpSessionIdentity(
  deps: PersistAcpSessionIdentityDeps,
  identity: RuntimeSessionIdentity,
  opts?: PersistAcpSessionIdentityOpts,
): Promise<void> {
  if (identity.acpSessionId === identity.runtimeId) {
    throw new AcpSessionIdentityOverloadError(identity);
  }

  const { db } = deps;
  const where = opts?.projectId
    ? and(
        eq(projectSessions.sessionId, identity.projectSessionId),
        eq(projectSessions.projectId, opts.projectId),
      )
    : eq(projectSessions.sessionId, identity.projectSessionId);

  const [current] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(where)
    .limit(1);

  await db.update(projectSessions).set({
    metadata: {
      ...((current?.metadata as Record<string, unknown> | null) ?? {}),
      runtime_protocol: 'acp',
      runtime_id: identity.runtimeId,
      acp_session_id: identity.acpSessionId,
    },
    updatedAt: new Date(),
  }).where(where);
}
