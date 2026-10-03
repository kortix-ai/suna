/**
 * Projections over one session-sandbox row: what an open observes, replays,
 * serializes, and when it calls a row stale. Split out of the former
 * routes/shared.ts (KRTX-274); every block below moved verbatim.
 */
import type {
  ProjectSessionSandbox,
  SessionStartFailure,
  SessionStartResult,
} from '@kortix/api-contract';
import { sessionSandboxes } from '@kortix/db';
import { type SandboxStatus } from '../../platform/providers';
import { classifySandboxProvisioningFailure } from '../../platform/services/sandbox-provisioning-error';
import { serializeSessionSandboxConfig } from '../lib/serializers';
import { repairInFlight } from '../session-lifecycle/readiness-clocks';
import {
  RUNTIME_START_MAX_FAILURES,
  RUNTIME_WAKE_GRACE_MS,
  runtimeStartFailureCount,
  runtimeStartRetryAtMs,
  runtimeWakeInProgress,
  stampedRuntimeFailureState,
} from '../session-lifecycle/runtime-wake-fence';

/**
 * The relative proxy path a client uses for all OpenCode (port 8000) traffic for
 * a session, resolved against the SDK's configured backendUrl. Keyed by
 * `external_id` — the same id the preview proxy's `loadSandbox()` looks up — so
 * the client never has to know the proxy URL scheme. This is the one place the
 * per-session runtime URL is shaped; the SDK consumes it opaquely.
 */
/**
 * The CONTROL transport address for a session's runtime: the OpenCode/daemon
 * REST channel, always the path proxy.
 *
 * This is deliberately NOT a preview origin and must never be used to build
 * one. It is called per turn by programmatic clients holding a bearer token;
 * resolving it through an origin would make every such request re-establish a
 * host-scoped session (a non-indexed sandbox-label lookup) and would put turn
 * delivery behind wildcard DNS, the certificate pack and the edge Worker.
 * Browser-facing URLs come from `previewOriginFor` / `previewUrlTemplate`
 * instead — see sandbox-proxy/preview-hosts.ts.
 */
export function sessionRuntimeUrlPath(externalId: string): string {
  return `/p/${externalId}/8000`;
}

const STALE_PENDING_PROVISIONING_MS = 10 * 60 * 1000;
const STALE_STARTED_PROVISIONING_MS = 5 * 60 * 1000;
const STALE_RUNTIME_WAKE_MS = RUNTIME_WAKE_GRACE_MS;

export function parseTimestampMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function staleProvisioningReason(
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

export function sandboxMetadata(row: typeof sessionSandboxes.$inferSelect): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
}

export function staleRuntimeWakeReason(
  row: typeof sessionSandboxes.$inferSelect,
  providerStatus: SandboxStatus,
  nowMs = Date.now(),
): string | null {
  if (row.status !== 'active' || !row.externalId) return null;
  if (providerStatus === 'running' || providerStatus === 'removed') return null;
  const metadata = sandboxMetadata(row);
  // An active repair is progress: never park a session the platform is fixing.
  //
  // This is the same rule `staleRuntimeReadyReason` carries (#7954), and this
  // is its SECOND call site — a session open has two clocks that park, and
  // guarding one of them fixed one of the two failure shapes. The budgets are
  // structurally incompatible without this line: the wake fence is
  // RUNTIME_WAKE_GRACE_MS (90s), a legacy-runtime repair is
  // LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS (8 min), so the fence parked EVERY
  // repair that needed more than 90 seconds and the platform then spent the
  // remaining ~6.5 minutes fixing a box it had already reported as `failed`.
  // Measured on a dev session, 2026-09-28: repair started 08:17:58.513,
  // park stamped 08:20:15.322 (`runtime_status_unknown_timeout`), repair ran on
  // until 08:26:08.293.
  //
  // `repairInFlight` is bounded by the repair's own budget, so a repair that
  // never reports a terminal state cannot hold the session open forever.
  if (repairInFlight(metadata, nowMs)) return null;
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

export function removedRuntimeStillInGrace(
  row: typeof sessionSandboxes.$inferSelect,
  nowMs = Date.now(),
): boolean {
  const metadata = sandboxMetadata(row);
  const graceStartedAtMs =
    parseTimestampMs(metadata.runtimeWakeStartedAt) ?? parseTimestampMs(metadata.initSucceededAt);
  return graceStartedAtMs != null && nowMs - graceStartedAtMs <= STALE_RUNTIME_WAKE_MS;
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

/**
 * The answer `/start` owes a STOPPED row before any provider call: a wake in
 * flight, a cooldown after a failed start, or a terminal verdict. `null` means
 * "nothing to replay" — the caller goes on to actually try.
 *
 * Exported for `stopped-wake-result.test.ts`, which pins the 2026-08-26
 * dead-end regression directly on this projection.
 */
export function stoppedWakeResult(
  row: typeof sessionSandboxes.$inferSelect | undefined,
  agentName: string | null,
  opencodeSessionId: string | null,
  now: Date = new Date(),
): SessionStartResult | null {
  if (row?.status !== 'stopped' || !row.externalId) return null;
  const metadata = sandboxMetadata(row);
  // An identity already preserved as unavailable outranks every wake clock on
  // this row. Both payloads below describe a wake that may still succeed, and
  // the cooldown one even advertises `retryable: true` — for a runtime the
  // provider has disowned that is a dead-end button, not a retry. Fall through
  // to the authoritative removed/recovery path, which either restores the box
  // in place or re-reports `runtime_identity_unavailable`.
  if (metadata.runtimeIdentityState !== 'unavailable' && runtimeWakeInProgress(metadata, now)) {
    return {
      stage: 'starting',
      agent_name: agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      opencode_session_id: opencodeSessionId,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason: 'runtime_waking',
    };
  }
  if (metadata.runtimeIdentityState === 'unavailable') return null;

  // A STAMPED runtime-start failure — `runtime_wake_failed` from a wake that
  // ran out of budget, `runtime_boot_failed` from a park. It used to short
  // -circuit every later `/start` to a terminal payload forever, so the session
  // could only be recovered by a human pressing Restart (2026-08-26: one prod
  // session answered `failed` in 47ms for a startable box; another replayed a
  // 03:37Z stamp for 10+ hours). Now it is a cooldown with three outcomes.
  const failureState = stampedRuntimeFailureState(metadata, now);
  // `retry`: say nothing here. The caller falls through to the resume path and
  // RE-ATTEMPTS the wake, which is the whole fix.
  if (failureState === null || failureState === 'retry') return null;

  const failureCount = runtimeStartFailureCount(metadata);
  const retryAtMs = runtimeStartRetryAtMs(metadata);
  const parkReason =
    typeof metadata.runtimeParkReason === 'string' ? metadata.runtimeParkReason : null;
  const stampReason =
    metadata.stopReason === 'runtime_wake_failed'
      ? 'runtime_wake_failed'
      : (parkReason ?? 'runtime_boot_failed');
  const evidence = {
    check: typeof metadata.runtimeWakeError === 'string' ? metadata.runtimeWakeError : stampReason,
    observed_at:
      typeof metadata.runtimeStartFailedAt === 'string'
        ? metadata.runtimeStartFailedAt
        : typeof metadata.runtimeWakeFailedAt === 'string'
          ? metadata.runtimeWakeFailedAt
          : typeof metadata.stoppedAt === 'string'
            ? metadata.stoppedAt
            : null,
    error: typeof metadata.lastInitError === 'string' ? metadata.lastInitError : null,
    attempts: failureCount,
    next_retry_at: retryAtMs !== null ? new Date(retryAtMs).toISOString() : null,
  };

  if (failureState === 'cooling_down') {
    // NOT a terminal answer and no longer dressed as one: the server itself
    // re-attempts once the cooldown lapses, so the honest stage is `starting`
    // and the honest `retriable` is true. Polling now makes progress.
    return {
      stage: 'starting',
      agent_name: agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      opencode_session_id: opencodeSessionId,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason: 'runtime_wake_cooldown',
      failure: {
        category: 'sandbox-provider',
        message:
          failureCount > 1
            ? `The runtime did not start (attempt ${failureCount}). Retrying automatically.`
            : 'The runtime did not start. Retrying automatically.',
        retryable: true,
        evidence,
      },
    };
  }

  // `terminal`: the attempt budget is spent, or the provider disowned the box.
  // Restart still clears it, and the verdict itself expires
  // (RUNTIME_START_FAILURE_TTL_MS) so a session opened later starts clean.
  return {
    stage: 'failed',
    agent_name: agentName ?? 'default',
    retriable: false,
    sandbox: serializeSandboxRow(row),
    opencode_session_id: opencodeSessionId,
    runtime_url: sessionRuntimeUrlPath(row.externalId),
    reason: stampReason,
    failure: {
      category: 'sandbox-provider',
      message: `The session runtime did not become reachable after ${Math.min(failureCount, RUNTIME_START_MAX_FAILURES)} attempts. Restart the session to try again.`,
      retryable: true,
      evidence,
    },
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
    rawCategory === 'unsupported-secret-delivery' ||
    rawCategory === 'invalid-secret-boundary-policy' ||
    rawCategory === 'snapshot-too-large' ||
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
  // These are configuration states, not transient faults: the identical input
  // produces the identical failure every time, so offering a retry only wastes
  // the user's time. `snapshot-too-large` joins them — an image over the
  // provider's ceiling is over it on every attempt.
  const PERMANENT: ReadonlySet<string> = new Set([
    'unsupported-secret-delivery',
    'invalid-secret-boundary-policy',
    'snapshot-too-large',
  ]);
  return {
    category,
    message,
    retryable: !PERMANENT.has(category),
  };
}
