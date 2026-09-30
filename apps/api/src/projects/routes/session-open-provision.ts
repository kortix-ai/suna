/**
 * The disposition of a row the open cannot use as-is: park or preserve an
 * established runtime, allocate a fresh one, and the bounded admission
 * replacement. Split out of the former routes/shared.ts (KRTX-274); every
 * block below moved verbatim.
 */
import type { SessionStartResult } from '@kortix/api-contract';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { type SandboxProviderName, config } from '../../config';
import { type SandboxStatus, getProvider } from '../../platform/providers';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { db } from '../../shared/db';
import { withProjectGitAuth } from '../lib/git';
import { type ProjectRow } from '../lib/serializers';
import { allocateSessionRuntime } from '../lib/session-runtime-allocator';
import {
  projectImageAllowedForSession,
  repositoryAccessFromSessionMetadata,
  sandboxSlugFromSessionMetadata,
} from '../lib/session-sandbox-metadata';
import { buildSessionSandboxEnvVars, sandboxCallbackUnreachableReason } from '../lib/sessions';
import { legacyRehydrateSpec, rehydrateSessionChat } from '../legacy-migration-rehydrate';
import { transitionSession } from '../session-lifecycle/status-transitions';
import type { StartCallLog } from '../session-lifecycle/start-envelope';
import {
  RUNTIME_IDENTITY_UNAVAILABLE,
  parkEstablishedRuntime,
  preserveEstablishedRuntime,
  retireRefusedRuntime,
  retireUnmaterializedRuntime,
  runtimeLossVerdict,
} from '../runtime-identity';
import type { StopReason } from '../stop-reason';
import type {
  OpenSessionArgs,
  OpenSessionRow,
  OpenSessionRowWithExternalId,
} from './session-open-context';
import {
  sandboxMetadata,
  sessionRuntimeUrlPath,
  sessionStartFailureFromSandbox,
  serializeSandboxRow,
  staleProvisioningReason,
} from './stopped-wake-result';

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
  await transitionSession('provision', sessionId, { error: null });
  const opencodeModel =
    typeof session.metadata?.opencode_model === 'string' ? session.metadata.opencode_model : null;
  const runtimeMetadata = { opened_at: new Date().toISOString() };
  const sessionMetadata = { ...(session.metadata ?? {}), ...runtimeMetadata };
  const rehydrate = legacyRehydrateSpec(session.metadata, loaded.row.metadata, loaded.row.projectId);

  allocateSessionRuntime({
    sessionId,
    accountId: loaded.row.accountId,
    projectId,
    userId: loaded.userId,
    project: loaded.row,
    providerName,
    baseRef: session.baseRef ?? loaded.row.defaultBranch,
    agentName: session.agentName ?? 'default',
    allowProjectImage: projectImageAllowedForSession(
      session.agentName,
      repositoryAccessFromSessionMetadata(session.metadata),
    ),
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
        repositoryAccess: repositoryAccessFromSessionMetadata(session.metadata),
        restoreSessionBranch: true,
      }),
    resolveGitProject: async () => withProjectGitAuth(loaded.row),
    beforeActive: rehydrate
      ? (externalId) =>
          rehydrateSessionChat({
            sessionId,
            externalId,
            provider: providerName,
            spec: rehydrate,
          })
      : undefined,
  });
}

// Exported ONLY for `preserve-established-runtime-on-open.test.ts`, which pins
// the four (five) existing populations this helper still serves untouched —
// admission refusal is deliberately NOT among them any more; see
// `replaceRefusedRuntimeOnOpen` below.
export async function preserveEstablishedRuntimeOnOpen(
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
  /** A provider status the CALLER just observed, so the loss gate below does
   *  not re-probe. Pass only a fresh answer; omit to let the gate ask. */
  knownProviderStatus?: SandboxStatus,
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
  // Incident 2026-08-14: only a definitive provider `removed` may become the
  // terminal "computer was lost" state. Two healthy boxes were preserved as
  // lost because a dead local tunnel kept them from booting and nothing asked
  // the provider first. Anything short of `removed` — including `unknown`,
  // which is a probe failure, not evidence — parks the row retriable instead.
  // try/catch, not .catch(): getProvider() itself throws SYNCHRONOUSLY for a
  // disabled provider (missing API key), and that must read as "cannot ask" —
  // park — never as a 500 out of /start.
  let providerStatus: SandboxStatus = knownProviderStatus ?? 'unknown';
  if (!knownProviderStatus) {
    try {
      providerStatus = await getProvider(row.provider as SandboxProviderName).getStatus(
        row.externalId,
      );
    } catch {
      providerStatus = 'unknown';
    }
  }
  if (runtimeLossVerdict(providerStatus) === 'park') {
    const parked = await parkEstablishedRuntime(row, reason, stopReason);
    return {
      stage: 'failed',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(parked ?? row),
      opencode_session_id: null,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
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

/** How many times ONE session's box may be replaced for a failed Rule 4
 *  admission check inside {@link ADMISSION_REPLACE_WINDOW_MS}. 3 per 15
 *  minutes: enough for a transient admission miss — a slow catalog probe, a
 *  momentary git-mirror hiccup — to self-heal on a fresh box; too few to spin
 *  forever on a systemic failure (a broken image, a missing boot-time
 *  credential) that a fresh box cannot fix either. */
export const ADMISSION_REPLACE_MAX_PER_WINDOW = 3;
export const ADMISSION_REPLACE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Bounds admission-triggered replacement so it cannot loop forever on one
 * session (Rule 4's replacement must terminate, even against a box that will
 * never pass admission).
 *
 * The counter lives on `project_sessions.metadata`, never on the sandbox row:
 * {@link retireRefusedRuntime} DELETES the sandbox row, so the session — the
 * durable identity that survives every replacement — is the only place that
 * can count them across replacements.
 *
 * Computed entirely in SQL against the row's value at write time, never a
 * value this process read earlier and would write back — see the learning
 * "never write back a JSONB column you read earlier: merge in SQL".
 */
export async function claimAdmissionReplacementBudget(
  sessionId: string,
  now: Date = new Date(),
): Promise<{ allowed: boolean; count: number }> {
  const cutoffIso = new Date(now.getTime() - ADMISSION_REPLACE_WINDOW_MS).toISOString();
  const nowIso = now.toISOString();
  const [updated] = await db
    .update(projectSessions)
    .set({
      metadata: sql`jsonb_set(
        jsonb_set(
          coalesce(${projectSessions.metadata}, '{}'::jsonb),
          '{runtimeAdmissionReplaceCount}',
          to_jsonb((
            CASE
              WHEN ${projectSessions.metadata}->>'runtimeAdmissionReplacedAt' IS NULL
                OR (${projectSessions.metadata}->>'runtimeAdmissionReplacedAt')::timestamptz < ${cutoffIso}::timestamptz
              THEN 1
              ELSE coalesce((${projectSessions.metadata}->>'runtimeAdmissionReplaceCount')::int, 0) + 1
            END
          )::int)
        ),
        '{runtimeAdmissionReplacedAt}',
        to_jsonb(${nowIso}::text)
      )`,
      updatedAt: now,
    })
    .where(eq(projectSessions.sessionId, sessionId))
    .returning({ metadata: projectSessions.metadata });
  const count = Number(
    (updated?.metadata as Record<string, unknown> | undefined)?.runtimeAdmissionReplaceCount ?? 0,
  );
  return { allowed: count > 0 && count <= ADMISSION_REPLACE_MAX_PER_WINDOW, count };
}

/**
 * Rule 4's actual replacement: "before a box is handed to a session, it must
 * prove its runtime identity… A box that fails admission is replaced, not
 * used." An admission refusal is a FIFTH, different population from the four
 * `preserveEstablishedRuntimeOnOpen` already serves (a stalled provision, a
 * failed wake, a failed boot, a real provider removal) — none of those boxes
 * are known-bad-but-servable the way a refused-admission box is — so it gets
 * its own path instead of a flag on that helper.
 *
 * The box is retired (`retireRefusedRuntime`) and a fresh one is allocated on
 * the SAME session (`allocateRuntimeOnOpen`), bounded by
 * `claimAdmissionReplacementBudget` so a session whose fresh box also fails
 * admission cannot replace forever. Never returns `stage:'failed'` with
 * `RUNTIME_IDENTITY_UNAVAILABLE` — that constant is what the web renders as
 * "This session's computer was lost", and a deliberate platform replacement is
 * not a loss.
 *
 * Collaborators are injected (same shape as `admitRunningSandbox`'s and
 * `guaranteeCurrentRuntimeOnOpen`'s `deps` parameter) purely for testability;
 * every real call site uses the defaults.
 */
export async function replaceRefusedRuntimeOnOpen(
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
  deps: {
    claimBudget?: typeof claimAdmissionReplacementBudget;
    retire?: typeof retireRefusedRuntime;
    allocate?: typeof allocateRuntimeOnOpen;
  } = {},
): Promise<SessionStartResult> {
  const claimBudget = deps.claimBudget ?? claimAdmissionReplacementBudget;
  const retire = deps.retire ?? retireRefusedRuntime;
  const allocate = deps.allocate ?? allocateRuntimeOnOpen;

  const budget = await claimBudget(sessionId);
  if (!budget.allowed) {
    return {
      stage: 'failed',
      agent_name: visible.row.agentName ?? 'default',
      retriable: false,
      sandbox: serializeSandboxRow(row),
      opencode_session_id: null,
      runtime_url: row.externalId ? sessionRuntimeUrlPath(row.externalId) : undefined,
      reason: 'runtime_admission_replace_exhausted',
      failure: {
        category: 'sandbox-provider',
        message: `This session's runtime failed admission and was replaced ${budget.count} times in ${Math.round(ADMISSION_REPLACE_WINDOW_MS / 60_000)} minutes. An operator must inspect it before it opens again.`,
        retryable: false,
        evidence: {
          check: reason,
          observed_at: new Date().toISOString(),
          error: null,
          attempts: budget.count,
          next_retry_at: null,
        },
      },
    };
  }

  const retired = await retire(row, reason);
  if (!retired) {
    // A live turn, a lost claim race, or a provider stop that genuinely
    // failed — transient by construction. The client polls /start again and
    // admission (and this replacement) is re-evaluated from scratch, exactly
    // like every other retriable stage in this file.
    return {
      stage: 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      opencode_session_id: null,
      runtime_url: row.externalId ? sessionRuntimeUrlPath(row.externalId) : undefined,
      reason,
    };
  }

  await allocate(loaded, visible.row, projectId, sessionId);
  return {
    stage: 'provisioning',
    agent_name: visible.row.agentName ?? 'default',
    retriable: true,
    sandbox: null,
    opencode_session_id: null,
    reason,
  };
}

/**
 * The not-usable-row phase of `runOpenSession`: report the session's terminal
 * state, preserve an established runtime, or provision a fresh box. Body is
 * the original `runOpenSession` branch, verbatim (KRTX-274 split); it answers
 * `null` when the row IS usable and the open continues.
 */
export async function openUnusableRow(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRow | undefined,
  stoppedProviderStatus: SandboxStatus | null,
): Promise<SessionStartResult | null> {
  const { loaded, visible, projectId, sessionId } = args;
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
        log.did('reconciled');
      log.did('reconciled');
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
      log.did('provisioned');
    }
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
    };
  }
  return null;
}

/** The stale-provisioning phase: hand a stalled provision to the preserve path. */
export async function openStaleProvisioningRow(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRow | undefined,
): Promise<SessionStartResult | null> {
  const { loaded, visible, projectId, sessionId } = args;
  const staleProvisioning = row ? staleProvisioningReason(row) : null;
  if (row && staleProvisioning) {
    log.did('reconciled');
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
  return null;
}

/** A same-id restore that already owns the provider operation replays its lease. */
export function openRecoveryClaimAnswer(
  args: OpenSessionArgs,
  row: OpenSessionRow,
): SessionStartResult | null {
  const { visible } = args;
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
  return null;
}

/** Still provisioning, or active but external_id not yet written. */
export function openProvisioningRowAnswer(
  args: OpenSessionArgs,
  row: OpenSessionRow,
): SessionStartResult | null {
  const { visible } = args;
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
  return null;
}
