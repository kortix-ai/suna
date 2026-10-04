/**
 * In-place recovery and provider-truth branches for an established row:
 * a removed box, a box the provider no longer reports running, and the
 * recovered-runtime finalize. Split out of the former routes/shared.ts
 * (KRTX-274); every block below moved verbatim.
 */
import type { SessionStartResult } from '@kortix/api-contract';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { type SandboxStatus, getProvider } from '../../platform/providers';
import { db } from '../../lib/db';
import { runStoppedObservationFollowUp } from '../../services/sessions/lifecycle/stopped-observation-followup';
import type { StartCallLog } from '../../services/sessions/lifecycle/start-envelope';
import {
  claimInPlaceRuntimeRecovery,
  finalizeRecoveredRuntimeIfRunning,
  markInPlaceRuntimeRecoveryAccepted,
} from '../../services/sandboxes/runtime-identity';
import type {
  OpenSessionArgs,
  OpenSessionRow,
  OpenSessionRowWithExternalId,
} from './session-open-context';
import { preserveEstablishedRuntimeOnOpen } from './session-open-provision';
import { markRuntimeWakeStarted } from './session-open-readiness';
import { resumeStoppedSandbox } from './resume-stopped-sandbox';
import {
  removedRuntimeStillInGrace,
  sandboxMetadata,
  serializeSandboxRow,
  sessionRuntimeUrlPath,
  staleRuntimeWakeReason,
} from './stopped-wake-result';

/**
 * The removed-box phase: grace, the in-place recovery claim, or the preserve
 * path. Body verbatim from the original `runOpenSession` (KRTX-274 split);
 * answers `null` when the provider did not report `removed`.
 */
export async function openRemovedBox(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRowWithExternalId,
  provider: ReturnType<typeof getProvider>,
  providerStatus: SandboxStatus,
): Promise<SessionStartResult | null> {
  const { loaded, visible, projectId, sessionId } = args;
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
        opencode_session_id: visible.row.runtimeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_recovery_in_progress',
      };
    }
    const recovery = await provider.recoverInPlace?.(row.externalId).catch((err) => {
      console.warn(`[start] in-place recovery failed for ${row.externalId}:`, err);
      return 'unavailable' as const;
    });
    if (recovery === 'running' || recovery === 'recovering') {
      log.did('restored');
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
        opencode_session_id: visible.row.runtimeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason:
          recovery === 'running' ? 'runtime_recovered_in_place' : 'runtime_restoring_in_place',
      };
    }
    log.did('reconciled');
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
      'removed',
    );
  }
  return null;
}

/**
 * The not-running phase: an established row the provider no longer reports
 * running — in-place restore, stale-wake park, the confirmed-stop gate, or one
 * wake stamp. Body verbatim from the original `runOpenSession` (KRTX-274
 * split); answers `null` when the provider reports `running`.
 */
export async function openNotRunningBox(
  args: OpenSessionArgs,
  log: StartCallLog,
  row: OpenSessionRowWithExternalId,
  provider: ReturnType<typeof getProvider>,
  providerStatus: SandboxStatus,
): Promise<SessionStartResult | null> {
  const { loaded, visible, projectId, sessionId } = args;
  if (providerStatus !== 'running') {
    if (sandboxMetadata(row).runtimeIdentityState === 'recovering') {
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(row),
        opencode_session_id: visible.row.runtimeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_restoring_in_place',
      };
    }
    const staleWake = staleRuntimeWakeReason(row, providerStatus);
    if (staleWake) {
      log.did('reconciled');
      return preserveEstablishedRuntimeOnOpen(
        loaded,
        visible,
        projectId,
        sessionId,
        row,
        staleWake,
        'runtime_wake_failed',
        providerStatus,
      );
    }
    // The provider read said `stopped`, but this row still holds turn authority
    // and the stop was not confirmed by a second read. See below.
    let stopUnconfirmed = false;
    if (providerStatus === 'stopped') {
      // Provider truth says this active row is parked. Close the old compute
      // window and both durable states first. Then enter the same stopped-row
      // wake fence used by every other access path. No raw provider start exists
      // outside that fence.
      //
      // ONE read is not that truth while the row holds turn authority. This
      // endpoint is an UNSOLICITED OBSERVATION — it has stopped nothing itself —
      // and it is polled every second, while Daytona folds `stopping` and
      // `pending_stop` into `stopped` (services/sandboxes/daytona/state.ts). On
      // 2026-08-17T20:40:03Z one such read parked a prod session mid-turn,
      // settled its ledger `runtime_gone` and returned the client to the wake
      // flow with the turn's work lost. So it takes the same confirmation gate
      // as the reaper's poll: a second `stopped` read, one window later.
      const activeExternalId = row.externalId;
      const stateSync = await import('../../services/sandboxes/reaping/sandbox-state-sync');
      const parked = await stateSync.reconcileSandboxStoppedByExternalId(
        activeExternalId,
        new Date(),
        { confirmMidTurnStop: true },
      );
      if (parked) log.did('reconciled');
      const [stoppedRow] = await db
        .select()
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
        .limit(1);
      if (stoppedRow?.status === 'stopped') {
        if (
          await resumeStoppedSandbox({
            sandboxId: stoppedRow.sandboxId,
            sessionId: stoppedRow.sessionId,
            accountId: stoppedRow.accountId,
            provider: stoppedRow.provider,
            externalId: stoppedRow.externalId,
            metadata: stoppedRow.metadata as Record<string, unknown> | null,
          })
        ) {
          log.did('resumed');
        }
      } else if (stoppedRow?.status === 'active') {
        // Nothing was parked and nothing is waking: the box keeps running with
        // its turn intact. Say exactly that instead of claiming a wake — the
        // next poll either reads `running` again, which drops the marker, or
        // earns the confirmation and takes the branch above.
        stopUnconfirmed = true;
        // OWN the confirmation instead of hoping someone reads again. Without
        // this the row keeps claiming `running` for as long as nothing polls —
        // 5+ minutes on a prod session 2026-08-26, with the queued prompt delivered
        // against a box the provider had already stopped. Detached: the answer
        // this call returns must not wait a confirmation window for it.
        void runStoppedObservationFollowUp({
          externalId: activeExternalId,
          sandboxId: row.sandboxId,
          getStatus: () => provider.getStatus(activeExternalId).catch(() => 'unknown'),
          reconcile: (at) =>
            stateSync.reconcileSandboxStoppedByExternalId(activeExternalId, at, {
              confirmMidTurnStop: true,
            }),
        }).catch((err) =>
          console.warn(
            `[start] stopped-observation follow-up failed for ${activeExternalId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
      }
    } else {
      // Unknown is not permission to issue repeated provider starts. Record one
      // readiness clock and let the bounded stale path terminate it.
      await markRuntimeWakeStarted(row, providerStatus);
    }
    return {
      stage: 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason:
        providerStatus !== 'stopped'
          ? 'runtime_status_unknown'
          : stopUnconfirmed
            ? 'runtime_stop_unconfirmed'
            : 'runtime_waking',
    };
  }
  return null;
}

/**
 * The recovered-runtime finalize plus the pending-stop marker clear for a
 * provider-running box, and the external_id guard. Body verbatim from the
 * original `runOpenSession` (KRTX-274 split). Returns the stopped answer when
 * the recovery was cancelled, else the (possibly finalized) row and its
 * external id.
 */
export async function syncRecoveredRunningRow(
  args: OpenSessionArgs,
  row: OpenSessionRow,
): Promise<SessionStartResult | { row: OpenSessionRow; runningExternalId: string }> {
  const { visible } = args;
  // The provider says RUNNING, so the pending-stop confirmation this endpoint
  // may have armed above is answered: drop it.
  //
  // A confirmation is about ONE provider transition. This route is polled about
  // once a second and it can arm the marker; an endpoint that arms and never
  // disarms turns two transient `pending_stop` misreads MINUTES apart — with
  // hundreds of healthy `running` reads in between — into a confirmed park of a
  // live box. Only a row that carries a marker pays for the write, and the
  // reaper's own running read does the same thing for rows nobody is polling.
  if (sandboxMetadata(row).pendingStopObservedAtMs !== undefined) {
    await import('../../services/sandboxes/reaping/sandbox-state-sync').then((m) =>
      m.clearPendingStopObservation(row.sandboxId),
    );
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
  return { row, runningExternalId };
}
