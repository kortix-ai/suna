/**
 * The session-open orchestrator: `openSession` is the one call the dashboard
 * uses to bring a session runtime up. The branch bodies live in the sibling
 * modules this file sequences (KRTX-274 split of the former shared.ts).
 */
import type { SessionStartResult } from '@kortix/api-contract';
import { sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { type SandboxStatus, getProvider } from '../../platform/providers';
import { type SandboxProviderName } from '../../lib/config';
import { db } from '../../shared/db';
import { inspectSandboxRuntime } from '../runtime-inspection';
import { createStartCallLog, withStartEnvelope, type StartCallLog } from '../session-lifecycle/start-envelope';
import type {
  OpenSessionArgs,
  OpenSessionRowWithExternalId,
} from './session-open-context';
import {
  openProvisioningRowAnswer,
  openRecoveryClaimAnswer,
  openStaleProvisioningRow,
  openUnusableRow,
} from './session-open-provision';
import {
  judgeBootBudget,
  observeOpenCodeReadiness,
  stampUnreachableDiagnostics,
} from './session-open-readiness';
import { openNotRunningBox, openRemovedBox, syncRecoveredRunningRow } from './session-open-recovery';
import { enforceAdmission, enforceRuntimeGuarantee } from './session-open-guarantee';
import { resumeHibernatedOnOpen } from './resume-stopped-sandbox';
import {
  serializeSandboxRow,
  sessionRuntimeUrlPath,
  stoppedWakeResult,
} from './stopped-wake-result';

/**
 * THE authoritative session-open path — the single call the dashboard uses to
 * bring a session's runtime up. Idempotent: provisions a missing sandbox,
 * resumes a hibernated/idle one, and resolves the canonical OpenCode pin once the
 * box is reachable. Returns ONE readiness payload the client polls until `ready`.
 */
export async function openSession(args: OpenSessionArgs): Promise<SessionStartResult> {
  // ONE log per call. Every branch below records what it DID and what it
  // OBSERVED; the envelope is assembled once, here, from that record — so a
  // payload that claims a negative without a live check is not expressible.
  const log = createStartCallLog();
  const result = await runOpenSession(args, log);
  // A RETIRED model pin is repaired here, at the open — not only when the box
  // is provisioned. A resumed box never rebuilds its env, so the model baked
  // into OpenCode's config at its ORIGINAL provision outlives every later
  // lineup rotation and every turn on it dies. See
  // `lib/session-model-repair.ts` for the measurement.
  //
  // DYNAMIC import, and the reason is not style: a static edge from this module
  // pulls `sandbox-env-sync` -> `sandbox-proxy` into this file's module-init
  // graph, and closing that cycle is exactly what broke the API boot in #7859
  // (`ReferenceError: Cannot access 'preview' before initialization`) with a
  // clean typecheck. Only a healthy session's FAST PATH runs, and it does no
  // import at all.
  if (result.stage === 'ready') {
    try {
      const { pinNeedsRepair, repairRetiredSessionModelOnOpen } = await import(
        '../lib/session-model-repair'
      );
      const metadata = (args.visible.row.metadata ?? null) as Record<string, unknown> | null;
      if (pinNeedsRepair(metadata)) {
        await repairRetiredSessionModelOnOpen({
          projectId: args.projectId,
          sessionId: args.sessionId,
          accountId: args.visible.row.accountId,
          userId: args.loaded.userId,
          agentName: args.visible.row.agentName,
          metadata,
        });
      }
    } catch (error) {
      // Never fails an open. The turn's own `model_retired` error remains the
      // fallback explanation, exactly as before this ran.
      console.warn(
        '[start] retired model repair skipped:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  return withStartEnvelope(
    result,
    log,
    (result.sandbox?.metadata ?? {}) as Record<string, unknown>,
  );
}

/**
 * The branch sequence of the open. Each branch body lives in the sibling
 * module that owns it; this function only loads the row and walks the phases
 * in the original order, returning the first answer a phase serves.
 */
async function runOpenSession(
  args: OpenSessionArgs,
  log: StartCallLog,
): Promise<SessionStartResult> {
  const { visible, projectId, sessionId } = args;
  const accountId = visible.row.accountId;
  let stoppedProviderStatus: SandboxStatus | null = null;

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

  // Gate browser polling before any provider call. A live wake coalesces behind
  // its durable claim. A failed wake returns one terminal cooldown payload.
  // Reversing this order issues another provider start on every `/start` poll.
  const existingWake = stoppedWakeResult(
    row,
    visible.row.agentName,
    visible.row.runtimeSessionId,
    log.observedAt,
  );
  if (existingWake) {
    log.did(existingWake.reason === 'runtime_wake_cooldown' ? 'cooling_down' : 'awaited_wake');
    return existingWake;
  }

  ({ row, stoppedProviderStatus } = await resumeHibernatedOnOpen(log, row));

  const resumedWake = stoppedWakeResult(
    row,
    visible.row.agentName,
    visible.row.runtimeSessionId,
    log.observedAt,
  );
  if (resumedWake) {
    if (resumedWake.reason === 'runtime_wake_cooldown') log.did('cooling_down');
    return resumedWake;
  }

  const unusable = await openUnusableRow(args, log, row, stoppedProviderStatus);
  if (unusable) return unusable;

  const stale = await openStaleProvisioningRow(args, log, row);
  if (stale) return stale;

  const recoveryClaim = openRecoveryClaimAnswer(args, row);
  if (recoveryClaim) return recoveryClaim;

  const notYetExternal = openProvisioningRowAnswer(args, row);
  if (notYetExternal) return notYetExternal;

  // The gate above answers every row still missing its external_id; the
  // established-row phases all read it as set. Narrow once, without a cast.
  if (!row.externalId) throw new Error('runOpenSession: established row without external_id');
  const establishedRow = { ...row, externalId: row.externalId };
  const observed = await observeProviderStatus(args, log, establishedRow, stoppedProviderStatus);
  const { provider, providerStatus } = observed;

  const removed = await openRemovedBox(args, log, establishedRow, provider, providerStatus);
  if (removed) return removed;

  const notRunning = await openNotRunningBox(args, log, establishedRow, provider, providerStatus);
  if (notRunning) return notRunning;

  return stageRunningOpen(args, log, establishedRow);
}

/**
 * The provider-running tail of the open: sync the recovering row, stage the
 * OpenCode readiness, then judge the boot budget, the runtime guarantee and
 * admission, in the original order, returning the first answer served.
 */
async function stageRunningOpen(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRowWithExternalId,
): Promise<SessionStartResult> {
  const synced = await syncRecoveredRunningRow(args, row);
  if ('stage' in synced) return synced;

  const readiness = await observeOpenCodeReadiness(args, log, synced.row, synced.runningExternalId);
  await stampUnreachableDiagnostics(synced.row, readiness.ensured, synced.runningExternalId);

  const parked = await judgeBootBudget(
    args,
    log,
    synced.row,
    readiness.ensured,
    readiness.serving,
    readiness.servingAnswer,
    synced.runningExternalId,
    readiness.booting,
  );
  if (parked) return parked;

  const guaranteed = await enforceRuntimeGuarantee(
    args,
    synced.row,
    synced.runningExternalId,
    readiness.booting,
  );
  if (guaranteed) return guaranteed;

  const admitted = await enforceAdmission(
    args,
    log,
    synced.row,
    synced.runningExternalId,
    readiness.booting,
  );
  if (admitted) return admitted;

  if (readiness.serving) return readiness.servingAnswer;
  return {
    stage: readiness.booting ? 'starting' : 'ready',
    agent_name: args.visible.row.agentName ?? 'default',
    retriable: readiness.booting,
    sandbox: serializeSandboxRow(synced.row),
    opencode_session_id: readiness.ensured.pin,
    runtime_url: sessionRuntimeUrlPath(synced.runningExternalId),
    reason: readiness.ensured.reason,
    ...(readiness.capabilities ? { capabilities: readiness.capabilities } : {}),
  };
}

/** The provider observation phase of `runOpenSession` (verbatim branch). */
async function observeProviderStatus(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRowWithExternalId,
  stoppedProviderStatus: SandboxStatus | null,
): Promise<{ provider: ReturnType<typeof getProvider>; providerStatus: SandboxStatus }> {
  const { loaded } = args;
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
  log.sawProvider(providerStatus);
  let observedRuntimeHealth: Awaited<ReturnType<typeof inspectSandboxRuntime>> = null;
  if (providerStatus === 'unknown') {
    observedRuntimeHealth = await inspectSandboxRuntime(row.externalId, loaded.userId);
    if (observedRuntimeHealth) {
      providerStatus = 'running';
      log.sawProvider(providerStatus);
      log.sawRuntime('ready');
    } else {
      log.sawRuntime('unreachable');
    }
  }
  return { provider, providerStatus };
}
