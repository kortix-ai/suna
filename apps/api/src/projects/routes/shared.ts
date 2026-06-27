import {
  endComputeSession,
  reopenComputeForSandbox,
} from '../../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../../config';
import { auth, json } from '../../openapi';
import { getProvider, type SandboxStatus } from '../../platform/providers';
import { db } from '../../shared/db';
import { resolveBranchTip } from '../git';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { rehydrateSessionChat } from '../legacy-migration-rehydrate';
import { changeRequests, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { resolveProjectGitAuth } from '../lib/git';
import {
  ProjectRow,
  serializeSessionSandboxConfig,
} from '../lib/serializers';
import { allocateSessionRuntime } from '../lib/session-runtime-allocator';
import {
  buildSessionSandboxEnvVars,
  sandboxCallbackUnreachableReason,
} from '../lib/sessions';
import { ensureOpencodeSessionPin } from '../opencode-mapping';

/**
 * Resume a hibernated (status='stopped') session sandbox IN PLACE instead of
 * destroying it and cold-reprovisioning a fresh one. A stopped row whose
 * `externalId` is still set is a powered-down VM whose disk — the repo clone,
 * installed deps, opencode — is intact, so resuming it skips the dominant boot
 * costs (snapshot pull + clone + deps).
 *
 * Atomically wins the stopped→active transition (so concurrent opens don't
 * double-start the provider), flips the session back to `running`, reopens
 * compute metering, and kicks the provider start in the background. The
 * caller returns `active` immediately; the frontend's existing health poll
 * waits for the container to come back — identical to the idle-wake path.
 *
 * On a hard provider-start failure the row is reverted to `stopped` so the
 * next open simply retries the resume (transient blips self-heal).
 *
 * Returns true when THIS call won the transition (and kicked the start).
 */
export async function resumeStoppedSandbox(row: {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  provider: string;
  externalId: string | null;
}): Promise<boolean> {
  if (!row.externalId) return false;
  if (
    !(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(
      row.provider,
    )
  )
    return false;

  const externalId = row.externalId;
  const now = new Date();
  // Conditional update = the lock: only the request that flips stopped→active
  // proceeds to start the VM. Concurrent polls see `active` and just return it.
  const [won] = await db
    .update(sessionSandboxes)
    .set({
      status: 'active',
      updatedAt: now,
      // Explicit resume clears the reaper's idle-quiesce marker so the resumed
      // box is treated normally again (passive traffic can keep it warm until
      // the next idle window).
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) - 'idleQuiesced' - 'idleQuiescedAt'`,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, row.sandboxId),
        eq(sessionSandboxes.status, 'stopped'),
      ),
    )
    .returning();
  if (!won) return false;

  await db
    .update(projectSessions)
    .set({ status: 'running', updatedAt: now })
    .where(eq(projectSessions.sessionId, row.sessionId))
    .catch((err) =>
      console.warn(
        `[projects] failed to mark session running on resume for ${row.sessionId}:`,
        err,
      ),
    );

  void reopenComputeForSandbox(
    row.sandboxId,
    row.accountId,
    row.sessionId,
  ).catch((err) =>
    console.warn(`[projects] compute reopen failed for ${row.sandboxId}:`, err),
  );

  const provider = getProvider(row.provider as SandboxProviderName);
  void provider.start(externalId).catch(async (err) => {
    console.warn(
      `[projects] failed to resume sandbox ${externalId} for session ${row.sessionId}:`,
      err,
    );
    if (isMissingRuntimeError(err)) {
      await retireSessionSandboxRow(
        { sandboxId: row.sandboxId, externalId },
        'resume_missing_runtime',
      ).catch(() => {});
      return;
    }
    // Revert so a later open retries the resume instead of spinning the health
    // poll against a VM that never came up.
    await db
      .update(sessionSandboxes)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(
        and(
          eq(sessionSandboxes.sandboxId, row.sandboxId),
          eq(sessionSandboxes.externalId, externalId),
        ),
      )
      .catch(() => {});
  });
  return true;
}

// ── Pre-resume on presence ───────────────────────────────────────────────────
// Throttle pre-resume per project so portal activity doesn't re-kick on every
// request. The resume itself is idempotent (resumeStoppedSandbox only acts on a
// stopped→active transition), so this is purely to avoid wasted DB lookups.
const preResumeThrottle = new Map<string, number>();
const PRERESUME_THROTTLE_MS = 30_000;

/**
 * When a user returns to a project, proactively resume their most-recently-used
 * STOPPED session sandbox(es) so the ~8s in-place resume (VM restart + opencode
 * re-warm) overlaps the user's navigation and the session is ready by the time
 * they open it. Reuses resumeStoppedSandbox (idempotent with the on-open resume:
 * if the box is already resuming/active, the conditional stopped→active lock
 * simply no-ops). Best-effort + fire-and-forget; GATED OFF by default
 * (KORTIX_PRERESUME_ENABLED) since it spends compute on a box the user might not
 * open. Scoped to the user's OWN sessions (never speculatively resumes someone
 * else's). Most-recent-first, capped at KORTIX_PRERESUME_MAX_PER_PROJECT.
 */
/**
 * The pre-resume candidates: the user's OWN most-recently-used STOPPED session
 * sandboxes in a project (status='stopped', a provider box still attached, not a
 * warm-pool row). Most-recent-first, capped at `limit`. Pure DB read, no side
 * effects — exported so the selection (ordering/scoping/status filter) is
 * testable without provisioning real sandboxes.
 */
export async function selectPreResumeTargets(
  projectId: string,
  userId: string,
  limit: number,
): Promise<Array<{ sandboxId: string; sessionId: string; accountId: string; provider: string; externalId: string | null }>> {
  return db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
    })
    .from(sessionSandboxes)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
    .where(and(
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.status, 'stopped'),
      isNotNull(sessionSandboxes.externalId),
      isNull(sessionSandboxes.poolState),
      eq(projectSessions.createdBy, userId),
    ))
    .orderBy(desc(sessionSandboxes.lastUsedAt))
    .limit(Math.max(1, limit));
}

export function preResumeRecentStoppedSessions(projectId: string, userId?: string | null): void {
  if (!config.KORTIX_PRERESUME_ENABLED || !projectId || !userId) return;
  const nowMs = Date.now();
  if (nowMs - (preResumeThrottle.get(projectId) ?? 0) < PRERESUME_THROTTLE_MS) return;
  preResumeThrottle.set(projectId, nowMs);
  void (async () => {
    try {
      const rows = await selectPreResumeTargets(projectId, userId, config.KORTIX_PRERESUME_MAX_PER_PROJECT);
      let kicked = 0;
      for (const row of rows) {
        const won = await resumeStoppedSandbox(row).catch((err) => {
          console.warn(`[pre-resume] resume ${row.sandboxId.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
          return false;
        });
        if (won) kicked++;
      }
      if (kicked) console.log(`[pre-resume] kicked ${kicked} resume(s) for project ${projectId.slice(0, 8)}`);
    } catch (err) {
      console.warn('[pre-resume] failed:', err instanceof Error ? err.message : err);
      preResumeThrottle.delete(projectId); // let the next presence retry
    }
  })();
}

export async function allocateRuntimeOnOpen(
  loaded: { row: ProjectRow; userId: string },
  session: {
    sandboxProvider: string;
    baseRef: string | null;
    agentName: string | null;
    metadata?: Record<string, unknown> | null;
  },
  projectId: string,
  sessionId: string,
): Promise<void> {
  const providerName = session.sandboxProvider as SandboxProviderName;
  if (
    !(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(
      providerName,
    )
  )
    return;
  if (sandboxCallbackUnreachableReason()) return;
  await db
    .update(projectSessions)
    .set({ status: 'provisioning', error: null, updatedAt: new Date() })
    .where(eq(projectSessions.sessionId, sessionId));
  // Migrated session — restore its original chat as part of provisioning, before
  // the sandbox goes 'active' (so the frontend's ensure-opencode pin survives).
  const legacySandboxId = (
    loaded.row as {
      metadata?: { legacy_migration?: { source_sandbox_id?: unknown } };
    }
  ).metadata?.legacy_migration?.source_sandbox_id;
  const opencodeModel =
    typeof session.metadata?.opencode_model === 'string'
      ? session.metadata.opencode_model
      : null;
  const runtimeMetadata = { opened_at: new Date().toISOString() };
  const sessionMetadata = { ...(session.metadata ?? {}), ...runtimeMetadata };

  allocateSessionRuntime({
    sessionId,
    accountId: loaded.row.accountId,
    projectId,
    userId: loaded.userId,
    project: loaded.row,
    providerName,
    baseRef: session.baseRef ?? loaded.row.defaultBranch,
    agentName: session.agentName ?? 'default',
    runtimeMetadata,
    sessionMetadata,
    buildEnvVars: () =>
      buildSessionSandboxEnvVars({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        userId: loaded.userId,
        repoUrl: loaded.row.repoUrl,
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
        agentName: session.agentName ?? 'default',
        opencodeModel,
        llmGatewayEnabled: projectLlmGatewayEnabled(loaded.row.metadata),
      }),
    resolveGitAuthToken: async () =>
      (await resolveProjectGitAuth(loaded.row)).auth?.token ?? null,
    beforeActive:
      typeof legacySandboxId === 'string'
        ? (externalId) =>
            rehydrateSessionChat({
              sessionId,
              legacySandboxId,
              newExternalId: externalId,
            })
        : undefined,
  });
}

// ── Unified session-open orchestration ──────────────────────────────────────

export type SessionStartStage =
  | 'provisioning'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'failed';

export interface SessionStartResult {
  /** Coarse lifecycle stage the client renders + polls on. */
  stage: SessionStartStage;
  /** Whether polling /start again can make progress (false = terminal). */
  retriable: boolean;
  /** Serialized session_sandboxes row (same shape as GET /sandbox), or null. */
  sandbox: Record<string, unknown> | null;
  /** Canonical OpenCode root pin (resolved client-side once the box is ready). */
  opencode_session_id: string | null;
  /**
   * Relative proxy path for this session's OpenCode runtime (port 8000), composed
   * by the client against the SDK's configured backendUrl. The server owns the
   * proxy scheme so the client never builds `/p/<id>/<port>` itself — it treats
   * this as an opaque per-session runtime base. Absent until the box has an
   * external_id. See `sessionRuntimeUrlPath`.
   */
  runtime_url?: string | null;
  reason?: string;
}

/**
 * The relative proxy path a client uses for all OpenCode (port 8000) traffic for
 * a session, resolved against the SDK's configured backendUrl. Keyed by
 * `external_id` — the same id the preview proxy's `loadSandbox()` looks up — so
 * the client never has to know the proxy URL scheme. This is the one place the
 * per-session runtime URL is shaped; the SDK consumes it opaquely.
 */
export function sessionRuntimeUrlPath(externalId: string): string {
  return `/p/${externalId}/8000`;
}

export function isMissingRuntimeError(error: unknown): boolean {
  const err = error as
    | {
        statusCode?: unknown;
        status?: unknown;
        code?: unknown;
        message?: unknown;
      }
    | null
    | undefined;
  const status = err?.statusCode ?? err?.status;
  if (status === 404) return true;
  const code = typeof err?.code === 'string' ? err.code.toLowerCase() : '';
  if (code === 'not_found' || code === 'notfound') return true;
  const message =
    typeof err?.message === 'string'
      ? err.message.toLowerCase()
      : String(error ?? '').toLowerCase();
  return (
    message.includes('no such container') ||
    message.includes('container not found') ||
    message.includes('sandbox container not found') ||
    message.includes('failed to inspect sandbox container') ||
    message.includes('not found')
  );
}

export async function retireSessionSandboxRow(
  row: Pick<typeof sessionSandboxes.$inferSelect, 'sandboxId' | 'externalId'>,
  reason: string,
): Promise<void> {
  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(
      `[projects] failed to close compute session while retiring sandbox ${row.sandboxId} (${reason}):`,
      err,
    ),
  );
  if (row.externalId) {
    await db
      .delete(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sandboxId, row.sandboxId),
          eq(sessionSandboxes.externalId, row.externalId),
        ),
      );
    return;
  }
  console.warn(
    `[projects] retiring session sandbox ${row.sandboxId} without external_id (${reason})`,
  );
  await db
    .delete(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
}

function serializeSandboxRow(
  row: typeof sessionSandboxes.$inferSelect,
): Record<string, unknown> {
  return {
    sandbox_id: row.sandboxId,
    session_id: row.sessionId,
    project_id: row.projectId,
    account_id: row.accountId,
    provider: row.provider,
    external_id: row.externalId,
    base_url: row.baseUrl,
    status: row.status,
    config: serializeSessionSandboxConfig(row.config),
    metadata: row.metadata ?? {},
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function replaceStaleRuntimeOnOpen(
  loaded: { row: ProjectRow; userId: string },
  visible: {
    row: {
      sandboxProvider: string;
      baseRef: string | null;
      agentName: string | null;
      metadata?: Record<string, unknown> | null;
    };
  },
  projectId: string,
  sessionId: string,
  row: typeof sessionSandboxes.$inferSelect,
  reason: string,
): Promise<SessionStartResult> {
  await retireSessionSandboxRow(row, reason).catch((err) =>
    console.warn(
      `[projects] failed to retire stale runtime ${row.externalId} for session ${sessionId}:`,
      err,
    ),
  );
  await allocateRuntimeOnOpen(loaded, visible.row, projectId, sessionId);
  return {
    stage: 'provisioning',
    retriable: true,
    sandbox: null,
    opencode_session_id: null,
    reason,
  };
}

/**
 * THE authoritative session-open path — the single call the dashboard uses to
 * bring a session's runtime up. Idempotent: provisions a missing sandbox,
 * resumes a hibernated/idle one, and resolves the canonical OpenCode pin once the
 * box is reachable. Returns ONE readiness payload the client polls until `ready`.
 */
export async function openSession(args: {
  loaded: { row: ProjectRow; userId: string };
  visible: {
    row: {
      status: string;
      sandboxProvider: string;
      baseRef: string | null;
      agentName: string | null;
      opencodeSessionId: string | null;
      accountId: string;
      metadata?: Record<string, unknown> | null;
    };
  };
  projectId: string;
  sessionId: string;
}): Promise<SessionStartResult> {
  const { loaded, visible, projectId, sessionId } = args;
  const accountId = visible.row.accountId;

  let [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
      ),
    )
    .limit(1);

  // Resume a hibernated box in place (keeps its disk/workspace).
  if (
    row &&
    row.status === 'stopped' &&
    row.externalId &&
    (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(
      row.provider,
    )
  ) {
    // A box the reaper idle-stopped with `needsReprovision` cannot be safely
    // resumed in place (Platinum's stop→resume wedges the guest — the CH
    // resume-freeze). Replace it with a fresh box on open instead. This is an
    // EXPLICIT open, so it clears the idle state by re-provisioning.
    if ((row.metadata as Record<string, unknown> | null)?.needsReprovision) {
      return replaceStaleRuntimeOnOpen(loaded, visible, projectId, sessionId, row, 'reprovision_on_open');
    }
    await resumeStoppedSandbox({
      sandboxId: row.sandboxId,
      sessionId: row.sessionId,
      accountId: row.accountId,
      provider: row.provider,
      externalId: row.externalId,
    });
    const [resumed] = await db
      .select()
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
      .limit(1);
    if (resumed) row = resumed;
  }

  // No usable box → provision on open (or report a terminal state).
  const usable =
    row && (row.status === 'provisioning' || row.status === 'active');
  if (!usable) {
    if (['failed', 'stopped', 'completed'].includes(visible.row.status)) {
      return {
        stage: visible.row.status === 'failed' ? 'failed' : 'stopped',
        retriable: false,
        sandbox: null,
        opencode_session_id: null,
      };
    }
    if (visible.row.status !== 'provisioning') {
      if (row)
        await db
          .delete(sessionSandboxes)
          .where(eq(sessionSandboxes.sandboxId, sessionId))
          .catch(() => {});
      await allocateRuntimeOnOpen(loaded, visible.row, projectId, sessionId);
    }
    return {
      stage: 'provisioning',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
    };
  }

  // Still provisioning, or active but external_id not yet written.
  if (row.status === 'provisioning' || !row.externalId) {
    return {
      stage: 'provisioning',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      opencode_session_id: null,
    };
  }

  // Active + external_id. The provider may have idle-auto-stopped the box while
  // the row still reads 'active' (the row lies until the next health probe), so
  // confirm with a lightweight provider status check and wake it in place if
  // needed. We deliberately do NOT do the heavy daemon round-trip (OpenCode pin
  // resolve) here — that would block this endpoint for ~8s on a still-booting box
  // and it's polled every second. OpenCode readiness is the client health poll's
  // job; the canonical-pin hook resolves the root once the box reports healthy.
  const provider = getProvider(row.provider as SandboxProviderName);
  let providerStatus: SandboxStatus;
  try {
    providerStatus = await provider.getStatus(row.externalId);
  } catch {
    providerStatus = 'unknown';
  }

  if (providerStatus === 'removed') {
    return replaceStaleRuntimeOnOpen(
      loaded,
      visible,
      projectId,
      sessionId,
      row,
      'runtime_removed',
    );
  }

  if (providerStatus !== 'running') {
    // Idle auto-stop: kick the start in the background; the client keeps polling.
    void provider.start(row.externalId).catch(async (err) => {
      console.warn(
        `[start] failed to wake sandbox ${row.externalId} (session ${sessionId}):`,
        err,
      );
      if (isMissingRuntimeError(err)) {
        await retireSessionSandboxRow(row, 'wake_missing_runtime').catch(
          () => {},
        );
        await allocateRuntimeOnOpen(
          loaded,
          visible.row,
          projectId,
          sessionId,
        ).catch((allocErr) =>
          console.warn(
            `[start] failed to reallocate missing runtime for session ${sessionId}:`,
            allocErr,
          ),
        );
      }
    });
    return {
      stage: 'starting',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason:
        providerStatus === 'stopped'
          ? 'runtime_waking'
          : 'runtime_status_unknown',
    };
  }

  // Box is provider-running. Resolve OpenCode readiness + the canonical pin
  // server-side — safe now that the box is confirmed up, so the daemon answers
  // FAST (a 503 'not_ready' while OpenCode is still booting, not an 8s timeout
  // against a dead box). This keeps ALL the lifecycle logic server-side: the
  // client just polls until stage='ready' and gets the pin handed to it.
  const ensured = await ensureOpencodeSessionPin({
    projectId,
    sessionId,
    accountId,
    externalId: row.externalId,
    userId: loaded.userId,
    currentPin: visible.row.opencodeSessionId ?? null,
  });
  const booting =
    ensured.reason === 'not_ready' || ensured.reason === 'unreachable';
  return {
    stage: booting ? 'starting' : 'ready',
    retriable: booting,
    sandbox: serializeSandboxRow(row),
    opencode_session_id: ensured.pin,
    runtime_url: sessionRuntimeUrlPath(row.externalId),
    reason: ensured.reason,
  };
}

export async function refreshCrTips(input: {
  cr: typeof changeRequests.$inferSelect;
  project: {
    projectId: string;
    repoUrl: string;
    defaultBranch: string;
    manifestPath: string;
    gitAuthToken?: string | null;
  };
}) {
  const { cr, project } = input;
  if (cr.status !== 'open') return;
  try {
    const [baseSha, headSha] = await Promise.all([
      resolveBranchTip(project, cr.baseRef),
      resolveBranchTip(project, cr.headRef),
    ]);
    if (cr.headCommitSha === headSha && cr.baseCommitSha === baseSha) return;
    await db
      .update(changeRequests)
      .set({
        headCommitSha: headSha,
        baseCommitSha: baseSha,
        updatedAt: new Date(),
      })
      .where(eq(changeRequests.crId, cr.crId));
  } catch (error) {
    // Repo unreachable or branch missing — leave the CR alone so the UI can
    // still render the metadata it has.
    console.warn('[change-requests] tip refresh failed', {
      crId: cr.crId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// GET /v1/projects/:projectId/change-requests?status=open|merged|closed|all
