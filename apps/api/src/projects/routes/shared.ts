import type {
  ProjectSessionSandbox,
  SessionStartFailure,
  SessionStartResult,
} from '@kortix/api-contract';
import { changeRequests, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import {
  pauseComputeSession,
  reopenComputeForSandbox,
} from '../../billing/services/compute-metering';
import { type SandboxProviderName, config } from '../../config';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { auth, json } from '../../openapi';
import { type SandboxStatus, getProvider } from '../../platform/providers';
import { classifySandboxProvisioningFailure } from '../../platform/services/sandbox-provisioning-error';
import { db } from '../../shared/db';
import { resolveBranchTip } from '../git';
import { legacyRehydrateSpec, rehydrateSessionChat } from '../legacy-migration-rehydrate';
import { withProjectGitAuth } from '../lib/git';
import { type ProjectRow, serializeSessionSandboxConfig } from '../lib/serializers';
import { allocateSessionRuntime } from '../lib/session-runtime-allocator';
import {
  sandboxSlugFromSessionMetadata,
  workspaceModeFromSessionMetadata,
} from '../lib/session-sandbox-metadata';
import { buildSessionSandboxEnvVars, sandboxCallbackUnreachableReason } from '../lib/sessions';
import { ensureOpencodeSessionPin } from '../opencode-mapping';
import {
  RUNTIME_IDENTITY_UNAVAILABLE,
  claimInPlaceRuntimeRecovery,
  finalizeRecoveredRuntimeIfRunning,
  markInPlaceRuntimeRecoveryAccepted,
  preserveEstablishedRuntime,
  retireUnmaterializedRuntime,
} from '../runtime-identity';
import { inspectSandboxRuntime } from '../runtime-inspection';
import type { StopReason } from '../stop-reason';
import {
  RUNTIME_READINESS_CLOCK_KEYS,
  hasRuntimeReadinessClock,
  staleOpencodeReadyReason,
} from '../session-lifecycle/readiness-clocks';
import {
  RUNTIME_WAKE_GRACE_MS,
  waitForRuntimeWakeRunning,
} from '../session-lifecycle/runtime-wake-fence';

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
  metadata?: Record<string, unknown> | null;
}): Promise<boolean> {
  if (!row.externalId) return false;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) return false;

  const externalId = row.externalId;
  const now = new Date();
  const runtimeWakeId = crypto.randomUUID();
  const wakeMetadata = { ...(row.metadata ?? {}) };
  for (const key of [
    'runtimeIdentityState',
    'runtimeUnavailableReason',
    'runtimeUnavailableAt',
    'preservedExternalId',
    'needsReprovision',
    'runtimeWakeError',
    'runtimeWakeFailedAt',
    'opencodeReadyWaitStartedAt',
    'opencodeReadyWaitReason',
  ])
    delete wakeMetadata[key];
  Object.assign(wakeMetadata, {
    runtimeWakeStartedAt: now.toISOString(),
    runtimeWakeId,
    runtimeWakeProviderStatus: 'starting',
  });
  // Conditional update = the lock: only the request that flips stopped→active
  // proceeds to start the VM. Concurrent polls see `active` and just return it.
  const [won] = await db
    .update(sessionSandboxes)
    .set({
      status: 'active',
      updatedAt: now,
      // Explicit resume clears the stale runtime-identity keys. It stamps NO
      // liveness timestamp: the box's lifetime is `deadline_at`, and the DB
      // trigger re-anchors + re-floors it on this very stopped->active
      // transition. A TypeScript writer here could only get that wrong.
      metadata: wakeMetadata,
    })
    .where(
      and(eq(sessionSandboxes.sandboxId, row.sandboxId), eq(sessionSandboxes.status, 'stopped')),
    )
    .returning();
  if (!won) return false;

  await db
    .update(projectSessions)
    .set({ status: 'running', error: null, updatedAt: now })
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
    null,
    row.provider as SandboxProviderName,
  ).catch((err) => console.warn(`[projects] compute reopen failed for ${row.sandboxId}:`, err));

  const provider = getProvider(row.provider as SandboxProviderName);
  void provider
    .start(externalId)
    .then(async () => {
      const stopCancelledWake = () =>
        provider
          .stop(externalId)
          .catch((err) =>
            console.warn(
              `[projects] failed to re-stop cancelled wake ${externalId} for session ${row.sessionId}:`,
              err,
            ),
          );
      // Check wake ownership before any provider-state polling. A manual stop
      // clears runtimeWakeId. Its CAS loss must re-stop a late start() now, not
      // after the running-state poll expires.
      const [acceptedWake] = await db
        .update(sessionSandboxes)
        .set({
          metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeWakeProviderStatus: 'accepted' })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sessionSandboxes.sandboxId, row.sandboxId),
            eq(sessionSandboxes.externalId, externalId),
            eq(sessionSandboxes.status, 'active'),
            sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
          ),
        )
        .returning({ sandboxId: sessionSandboxes.sandboxId })
        .catch((err) => {
          console.warn(`[runtime-identity] failed to accept wake for ${row.sessionId}:`, err);
          return [] as Array<{ sandboxId: string }>;
        });
      if (!acceptedWake) {
        await stopCancelledWake();
        return;
      }
      // Platinum can acknowledge start while getStatus() still reports the
      // previous stopped state. Keep the wake fence until the provider proves
      // the runtime is running. Clearing it on acknowledgement lets the next
      // status poll close this meter and start a second wake for one resume.
      const providerRunning = await waitForRuntimeWakeRunning(() => provider.getStatus(externalId));
      if (!providerRunning) return;
      const [completedWake] = await db
        .update(sessionSandboxes)
        .set({
          metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) - 'runtimeWakeStartedAt' - 'runtimeWakeId' - 'runtimeWakeProviderStatus' - 'runtimeWakeError' - 'runtimeWakeFailedAt'`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sessionSandboxes.sandboxId, row.sandboxId),
            eq(sessionSandboxes.externalId, externalId),
            eq(sessionSandboxes.status, 'active'),
            sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
          ),
        )
        .returning({ sandboxId: sessionSandboxes.sandboxId })
        .catch((err) => {
          console.warn(`[runtime-identity] failed to clear wake fence for ${row.sessionId}:`, err);
          return [] as Array<{ sandboxId: string }>;
        });
      if (!completedWake) {
        // A real stop won while start() was in flight. The first provider.stop()
        // can finish before this late start, so enforce the user's stopped state
        // once more after start() resolves.
        await stopCancelledWake();
      }
    })
    .catch(async (err) => {
      console.warn(
        `[projects] failed to resume sandbox ${externalId} for session ${row.sessionId}:`,
        err,
      );
      // Never retire or replace an established identity based on a provider
      // start error. Revert this exact fenced wake so a later explicit open can
      // retry the original sandbox in place.
      const [revertedWake] = await db
        .update(sessionSandboxes)
        .set({
          status: 'stopped',
          metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeWakeError: isMissingRuntimeError(err) ? 'missing' : 'start_failed', runtimeWakeFailedAt: new Date().toISOString() })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sessionSandboxes.sandboxId, row.sandboxId),
            eq(sessionSandboxes.externalId, externalId),
            eq(sessionSandboxes.status, 'active'),
            sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
          ),
        )
        .returning({ sandboxId: sessionSandboxes.sandboxId })
        .catch(() => []);
      if (!revertedWake) return;
      await db
        .update(projectSessions)
        .set({ status: 'stopped', updatedAt: new Date() })
        .where(eq(projectSessions.sessionId, row.sessionId))
        .catch(() => {});
      // The meter was opened optimistically above, BEFORE provider.start() had
      // resolved. This branch is the proof it never came up, so the window must
      // close here — reverting the two status rows and leaving the meter running
      // is how a box that failed to start in 134ms went on accruing wall-clock
      // (observed in prod 2026-07-29). The billing-invariant sweep would also
      // catch it, but a leak this deterministic should not wait for a sweep.
      await pauseComputeSession(row.sandboxId).catch((pauseErr) =>
        console.warn(
          `[projects] compute pause after failed wake failed for ${row.sandboxId}:`,
          pauseErr,
        ),
      );
    });
  return true;
}

/**
 * Resume a stopped box addressed by its provider `external_id` (the id in proxy
 * URLs, `/v1/p/<externalId>/<port>`). Fetches the full row — crucially including
 * `metadata`, which {@link resumeStoppedSandbox} rewrites — so the sandbox-proxy
 * data path can wake a hibernated box the SAME way `/start` does when a real user
 * actively hits the OpenCode runtime. Idempotent: the conditional stopped→active
 * lock inside `resumeStoppedSandbox` de-dupes the concurrent session.list retries,
 * so at most one provider start is kicked. Returns true when THIS call won the
 * resume (false if it wasn't stopped, isn't resumable, or a concurrent call won).
 */
export async function resumeStoppedSandboxByExternalId(externalId: string): Promise<boolean> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
      status: sessionSandboxes.status,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row || row.status !== 'stopped' || !row.externalId) return false;
  return resumeStoppedSandbox({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    accountId: row.accountId,
    provider: row.provider,
    externalId: row.externalId,
    metadata: row.metadata,
  });
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
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) return;
  if (sandboxCallbackUnreachableReason()) return;
  await db
    .update(projectSessions)
    .set({ status: 'provisioning', error: null, updatedAt: new Date() })
    .where(eq(projectSessions.sessionId, sessionId));
  const opencodeModel =
    typeof session.metadata?.opencode_model === 'string' ? session.metadata.opencode_model : null;
  const runtimeMetadata = { opened_at: new Date().toISOString() };
  const sessionMetadata = { ...(session.metadata ?? {}), ...runtimeMetadata };
  const rehydrate = legacyRehydrateSpec(session.metadata, loaded.row.metadata);

  allocateSessionRuntime({
    sessionId,
    accountId: loaded.row.accountId,
    projectId,
    userId: loaded.userId,
    project: loaded.row,
    providerName,
    baseRef: session.baseRef ?? loaded.row.defaultBranch,
    agentName: session.agentName ?? 'default',
    sandboxSlug: sandboxSlugFromSessionMetadata(session.metadata),
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
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
        llmGatewayEnabled: projectLlmGatewayEnabled(loaded.row.metadata),
        workspaceMode: workspaceModeFromSessionMetadata(session.metadata),
      }),
    resolveGitProject: async () => withProjectGitAuth(loaded.row),
    beforeActive: rehydrate
      ? (externalId) =>
          rehydrateSessionChat({ sessionId, externalId, provider: providerName, spec: rehydrate })
      : undefined,
  });
}

// ── Unified session-open orchestration ──────────────────────────────────────
// The stage/result wire types live in @kortix/api-contract (the shared wire
// contract); re-exported here for the existing import sites.

export type {
  SessionStartResult,
  SessionStartStage,
} from '@kortix/api-contract';

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

const STALE_PENDING_PROVISIONING_MS = 10 * 60 * 1000;
const STALE_STARTED_PROVISIONING_MS = 5 * 60 * 1000;
const STALE_RUNTIME_WAKE_MS = RUNTIME_WAKE_GRACE_MS;
const STALE_OPENCODE_READY_MS = 5 * 60 * 1000;

function parseTimestampMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function staleProvisioningReason(
  row: typeof sessionSandboxes.$inferSelect,
  nowMs = Date.now(),
): string | null {
  if (row.status !== 'provisioning' || row.externalId) return null;
  const metadata =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : {};
  const initStatus = metadata.initStatus;
  const rowUpdatedAtMs = parseTimestampMs(row.updatedAt) ?? nowMs;

  if (initStatus === 'pending') {
    return nowMs - rowUpdatedAtMs > STALE_PENDING_PROVISIONING_MS
      ? 'stale_provisioning_pending'
      : null;
  }

  if (initStatus === 'provisioning' || initStatus === 'retrying') {
    const initUpdatedAtMs = parseTimestampMs(metadata.initUpdatedAt) ?? rowUpdatedAtMs;
    return nowMs - initUpdatedAtMs > STALE_STARTED_PROVISIONING_MS
      ? 'stale_provisioning_lost'
      : null;
  }

  return null;
}

function sandboxMetadata(row: typeof sessionSandboxes.$inferSelect): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function staleRuntimeWakeReason(
  row: typeof sessionSandboxes.$inferSelect,
  providerStatus: SandboxStatus,
  nowMs = Date.now(),
): string | null {
  if (row.status !== 'active' || !row.externalId) return null;
  if (providerStatus === 'running' || providerStatus === 'removed') return null;
  const metadata = sandboxMetadata(row);
  const wakeStartedAtMs = parseTimestampMs(metadata.runtimeWakeStartedAt);
  if (wakeStartedAtMs && nowMs - wakeStartedAtMs > STALE_RUNTIME_WAKE_MS) {
    return providerStatus === 'stopped' ? 'runtime_wake_timeout' : 'runtime_status_unknown_timeout';
  }

  // Existing bad rows predate runtimeWakeStartedAt. If the provider status is
  // unknown long after provider create succeeded, stop returning retriable
  // "starting" forever and surface the preserved identity as unavailable.
  const initSucceededAtMs = parseTimestampMs(metadata.initSucceededAt);
  if (
    !wakeStartedAtMs &&
    providerStatus === 'unknown' &&
    initSucceededAtMs &&
    nowMs - initSucceededAtMs > STALE_RUNTIME_WAKE_MS
  ) {
    return 'runtime_status_unknown_timeout';
  }
  return null;
}

function removedRuntimeStillInGrace(
  row: typeof sessionSandboxes.$inferSelect,
  nowMs = Date.now(),
): boolean {
  const metadata = sandboxMetadata(row);
  const graceStartedAtMs =
    parseTimestampMs(metadata.runtimeWakeStartedAt) ?? parseTimestampMs(metadata.initSucceededAt);
  return graceStartedAtMs != null && nowMs - graceStartedAtMs <= STALE_RUNTIME_WAKE_MS;
}

async function markRuntimeWakeStarted(
  row: typeof sessionSandboxes.$inferSelect,
  providerStatus: SandboxStatus,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  if (typeof metadata.runtimeWakeStartedAt === 'string') return;
  try {
    await db
      .update(sessionSandboxes)
      .set({
        metadata: {
          ...metadata,
          runtimeWakeStartedAt: new Date().toISOString(),
          runtimeWakeProviderStatus: providerStatus,
        },
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  } catch (err) {
    console.warn(`[start] failed to mark runtime wake for ${row.sandboxId}:`, err);
  }
}

async function markOpencodeReadyWaitStarted(
  row: typeof sessionSandboxes.$inferSelect,
  reason: string,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  if (typeof metadata.opencodeReadyWaitStartedAt === 'string') return;
  try {
    await db
      .update(sessionSandboxes)
      .set({
        metadata: {
          ...metadata,
          opencodeReadyWaitStartedAt: new Date().toISOString(),
          opencodeReadyWaitReason: reason,
        },
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  } catch (err) {
    console.warn(`[start] failed to mark OpenCode wait for ${row.sandboxId}:`, err);
  }
}

async function clearRuntimeReadinessClocks(
  row: typeof sessionSandboxes.$inferSelect,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  if (!hasRuntimeReadinessClock(metadata)) return;
  try {
    await db
      .update(sessionSandboxes)
      .set({
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
          - ${RUNTIME_READINESS_CLOCK_KEYS[0]}
          - ${RUNTIME_READINESS_CLOCK_KEYS[1]}
          - ${RUNTIME_READINESS_CLOCK_KEYS[2]}
          - ${RUNTIME_READINESS_CLOCK_KEYS[3]}
          - ${RUNTIME_READINESS_CLOCK_KEYS[4]}
          - ${RUNTIME_READINESS_CLOCK_KEYS[5]}`,
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  } catch (err) {
    console.warn(`[start] failed to clear readiness clocks for ${row.sandboxId}:`, err);
  }
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

export function serializeSandboxRow(
  row: typeof sessionSandboxes.$inferSelect,
): ProjectSessionSandbox {
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

export function sessionStartFailureFromSandbox(
  row: typeof sessionSandboxes.$inferSelect,
): SessionStartFailure | null {
  if (row.status !== 'error') return null;
  const metadata = sandboxMetadata(row);
  const rawCategory = metadata.failureCategory;
  const storedCategory =
    rawCategory === 'provider-capacity' ||
    rawCategory === 'git-auth' ||
    rawCategory === 'sandbox-provider'
      ? rawCategory
      : 'sandbox-provider';
  const rawProviderError =
    typeof metadata.lastProvisioningError === 'string'
      ? metadata.lastProvisioningError
      : typeof metadata.provisioningError === 'string'
        ? metadata.provisioningError
        : null;
  const inferredFailure = rawProviderError
    ? classifySandboxProvisioningFailure(rawProviderError)
    : null;
  const inferredSpecificFailure =
    storedCategory === 'sandbox-provider' && inferredFailure?.category !== 'sandbox-provider'
      ? inferredFailure
      : null;
  const category = inferredSpecificFailure?.category ?? storedCategory;
  const message =
    inferredSpecificFailure?.userMessage ??
    (typeof metadata.errorMessage === 'string' && metadata.errorMessage.length > 0
      ? metadata.errorMessage
      : 'The sandbox provider could not start this session. Try again.');
  return { category, message, retryable: true };
}

async function preserveEstablishedRuntimeOnOpen(
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
  /** WHICH park this is, for the classification query. Explicit per call site:
   *  this helper serves four unrelated populations (a stalled provision, a
   *  failed wake, a failed boot, a real provider removal) and cannot tell them
   *  apart from the inside. */
  stopReason: StopReason,
): Promise<SessionStartResult> {
  if (!row.externalId) {
    await retireUnmaterializedRuntime(row, reason);
    await allocateRuntimeOnOpen(loaded, visible.row, projectId, sessionId);
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
      reason,
    };
  }
  const preserved = await preserveEstablishedRuntime(row, reason, stopReason);
  return {
    stage: 'failed',
    agent_name: visible.row.agentName ?? 'default',
    retriable: false,
    sandbox: preserved ? serializeSandboxRow(preserved) : serializeSandboxRow(row),
    opencode_session_id: null,
    runtime_url: sessionRuntimeUrlPath(row.externalId),
    reason: RUNTIME_IDENTITY_UNAVAILABLE,
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

  // Resume a hibernated box in place (keeps its disk/workspace). Check provider
  // truth first: a terminal Platinum VM may need backup restoration, and sending
  // a normal start before that restore creates a second provider-side race.
  let stoppedProviderStatus: SandboxStatus | null = null;
  if (
    row &&
    row.status === 'stopped' &&
    row.externalId &&
    (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)
  ) {
    const provider = getProvider(row.provider as SandboxProviderName);
    stoppedProviderStatus = await provider
      .getStatus(row.externalId)
      .catch(() => 'unknown' as const);
    if (stoppedProviderStatus !== 'removed' || !provider.recoverInPlace) {
      await resumeStoppedSandbox({
        sandboxId: row.sandboxId,
        sessionId: row.sessionId,
        accountId: row.accountId,
        provider: row.provider,
        externalId: row.externalId,
        metadata: row.metadata as Record<string, unknown> | null,
      });
      const [resumed] = await db
        .select()
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
        .limit(1);
      if (resumed) row = resumed;
    }
  }

  // No usable box → provision on open (or report a terminal state).
  const usable =
    row &&
    (row.status === 'provisioning' ||
      row.status === 'active' ||
      (row.status === 'stopped' && row.externalId && stoppedProviderStatus === 'removed'));
  if (!usable) {
    if (['failed', 'stopped', 'completed'].includes(visible.row.status)) {
      return {
        stage: visible.row.status === 'failed' ? 'failed' : 'stopped',
        agent_name: visible.row.agentName ?? 'default',
        retriable: false,
        sandbox: row?.status === 'error' ? serializeSandboxRow(row) : null,
        opencode_session_id: null,
        failure: row ? sessionStartFailureFromSandbox(row) : null,
      };
    }
    if (visible.row.status !== 'provisioning') {
      if (row?.externalId) {
        return preserveEstablishedRuntimeOnOpen(
          loaded,
          visible,
          projectId,
          sessionId,
          row,
          'non_usable_established_runtime',
          'unusable_runtime_state',
        );
      }
      if (row) await retireUnmaterializedRuntime(row, 'non_usable_unmaterialized_runtime');
      await allocateRuntimeOnOpen(loaded, visible.row, projectId, sessionId);
    }
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
    };
  }

  const staleProvisioning = row ? staleProvisioningReason(row) : null;
  if (row && staleProvisioning) {
    return preserveEstablishedRuntimeOnOpen(
      loaded,
      visible,
      projectId,
      sessionId,
      row,
      staleProvisioning,
      'provisioning_stalled',
    );
  }

  // A same-id restore already owns the provider operation. Concurrent polls
  // must observe that lease without issuing another restore request.
  if (
    row.status === 'provisioning' &&
    row.externalId &&
    sandboxMetadata(row).runtimeIdentityState === 'recovery_claimed'
  ) {
    return {
      stage: 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      opencode_session_id: visible.row.opencodeSessionId,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason: 'runtime_recovery_in_progress',
    };
  }

  // Still provisioning, or active but external_id not yet written.
  if (
    (row.status === 'provisioning' && sandboxMetadata(row).runtimeIdentityState !== 'recovering') ||
    !row.externalId
  ) {
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
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
    providerStatus = stoppedProviderStatus ?? (await provider.getStatus(row.externalId));
  } catch {
    providerStatus = 'unknown';
  }
  let observedRuntimeHealth: Awaited<ReturnType<typeof inspectSandboxRuntime>> = null;
  if (providerStatus === 'unknown') {
    observedRuntimeHealth = await inspectSandboxRuntime(row.externalId, loaded.userId);
    if (observedRuntimeHealth) providerStatus = 'running';
  }

  if (providerStatus === 'removed') {
    if (removedRuntimeStillInGrace(row)) {
      await markRuntimeWakeStarted(row, providerStatus);
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: null,
        opencode_session_id: null,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_removed_checking',
      };
    }
    const claim = await claimInPlaceRuntimeRecovery(row);
    if (!claim) {
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(row),
        opencode_session_id: visible.row.opencodeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_recovery_in_progress',
      };
    }
    const recovery = await provider.recoverInPlace?.(row.externalId).catch((err) => {
      console.warn(`[start] in-place recovery failed for ${row.externalId}:`, err);
      return 'unavailable' as const;
    });
    if (recovery === 'running' || recovery === 'recovering') {
      const recoveringRow = await markInPlaceRuntimeRecoveryAccepted(claim, recovery);
      if (!recoveringRow) {
        return {
          stage: 'stopped',
          agent_name: visible.row.agentName ?? 'default',
          retriable: false,
          sandbox: null,
          opencode_session_id: null,
          reason: 'runtime_recovery_cancelled',
        };
      }
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(recoveringRow),
        opencode_session_id: visible.row.opencodeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason:
          recovery === 'running' ? 'runtime_recovered_in_place' : 'runtime_restoring_in_place',
      };
    }
    return preserveEstablishedRuntimeOnOpen(
      loaded,
      visible,
      projectId,
      sessionId,
      claim.row,
      'runtime_removed',
      // The provider itself answered `removed` and in-place recovery came back
      // unavailable — a real Path D2 removal, not a wake that ran out of time.
      'provider_removed',
    );
  }

  if (providerStatus !== 'running') {
    if (sandboxMetadata(row).runtimeIdentityState === 'recovering') {
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(row),
        opencode_session_id: visible.row.opencodeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_restoring_in_place',
      };
    }
    const staleWake = staleRuntimeWakeReason(row, providerStatus);
    if (staleWake) {
      return preserveEstablishedRuntimeOnOpen(
        loaded,
        visible,
        projectId,
        sessionId,
        row,
        staleWake,
        'runtime_wake_failed',
      );
    }
    await markRuntimeWakeStarted(row, providerStatus);
    // Idle auto-stop: kick the start in the background; the client keeps polling.
    void provider.start(row.externalId).catch(async (err) => {
      console.warn(`[start] failed to wake sandbox ${row.externalId} (session ${sessionId}):`, err);
      if (isMissingRuntimeError(err)) {
        await preserveEstablishedRuntime(row, 'wake_missing_runtime', 'runtime_wake_failed').catch(
          () => {},
        );
      }
    });
    return {
      stage: 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason: providerStatus === 'stopped' ? 'runtime_waking' : 'runtime_status_unknown',
    };
  }

  if (sandboxMetadata(row).runtimeIdentityState === 'recovering') {
    const finalized = await finalizeRecoveredRuntimeIfRunning(row);
    if (!finalized) {
      return {
        stage: 'stopped',
        agent_name: visible.row.agentName ?? 'default',
        retriable: false,
        sandbox: null,
        opencode_session_id: null,
        reason: 'runtime_recovery_cancelled',
      };
    }
    row = finalized;
  }
  const runningExternalId = row.externalId;
  if (!runningExternalId) {
    throw new Error(`Provider-running sandbox ${row.sandboxId} has no external_id`);
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
    externalId: runningExternalId,
    userId: loaded.userId,
    currentPin: visible.row.opencodeSessionId ?? null,
  });
  const booting = ensured.reason === 'not_ready' || ensured.reason === 'unreachable';
  if (booting) {
    const staleBoot = staleOpencodeReadyReason(
      sandboxMetadata(row),
      ensured.reason,
      Date.now(),
      STALE_OPENCODE_READY_MS,
    );
    if (staleBoot) {
      return preserveEstablishedRuntimeOnOpen(
        loaded,
        visible,
        projectId,
        sessionId,
        row,
        staleBoot,
        'runtime_boot_failed',
      );
    }
    await markOpencodeReadyWaitStarted(row, ensured.reason);
  } else {
    await clearRuntimeReadinessClocks(row);
  }
  return {
    stage: booting ? 'starting' : 'ready',
    agent_name: visible.row.agentName ?? 'default',
    retriable: booting,
    sandbox: serializeSandboxRow(row),
    opencode_session_id: ensured.pin,
    runtime_url: sessionRuntimeUrlPath(runningExternalId),
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
