import { sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { type SandboxProviderName, config } from '../../config';
import { getProvider } from '../../platform/providers';
import { stopSessionEnvironment } from '../../platform/services/session-environment';
import { db } from '../../shared/db';
import { isAlreadyNotRunning, isLifecycleTransitionInProgress } from '../reaping/policy';
import { applyStoppedState } from '../reaping/sandbox-state-sync';
import { abortLiveTurnBeforeStop } from '../reaping/stop-box';
import { RUNTIME_WAKE_LATE_START_GUARD_MS, runtimeWakeInProgress } from './runtime-wake-fence';

/**
 * Manual, user-triggered stop: pause the running sandbox in place (disk kept,
 * same contract as the stop-half of restart / the idle reaper's stop-idle
 * path) without provisioning anything new. Session stays resumable via
 * /start, exactly like an idle auto-stop would leave it.
 */
export async function stopSession(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  userId: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { projectId, sessionId, accountId, userId } = input;

  const [sandbox] = await db
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

  if (!sandbox) {
    return { status: 404, body: { error: 'Session sandbox not found' } };
  }
  const cancellingWake =
    sandbox.status === 'stopped' &&
    runtimeWakeInProgress((sandbox.metadata ?? {}) as Record<string, unknown>);
  if (sandbox.status !== 'active' && !cancellingWake) {
    return {
      status: 409,
      body: { error: 'Session is not running', status: sandbox.status },
    };
  }
  if (
    !sandbox.externalId ||
    !(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(sandbox.provider)
  ) {
    return {
      status: 400,
      body: { error: `Stop is not supported for provider ${sandbox.provider}` },
    };
  }

  const provider = getProvider(sandbox.provider as SandboxProviderName);
  const now = new Date();
  if (cancellingWake) {
    // Cancel the durable wake before the provider call. The in-flight wake task
    // then loses its finalize CAS and stops any provider start that completes
    // after this request. The cleanup guard covers a task or pod that never
    // returns from provider.start().
    await applyStoppedState({
      sandboxId: sandbox.sandboxId,
      sessionId,
      externalId: sandbox.externalId,
      stopReason: 'manual',
      metadata: {
        stoppedBy: userId,
        runtimeWakeCleanupUntilAt: new Date(
          now.getTime() + RUNTIME_WAKE_LATE_START_GUARD_MS,
        ).toISOString(),
      },
      now,
    });
  }
  // Close the live turn before powering the box off, but only when the box is
  // actually running one: `cancellingWake` means the row is already stopped
  // (a wake was mid-flight), so there is no live opencode process to abort.
  if (!cancellingWake) {
    await abortLiveTurnBeforeStop({
      sandboxId: sandbox.sandboxId,
      externalId: sandbox.externalId,
      userId,
    });
  }

  try {
    await provider.stop(sandbox.externalId);
  } catch (err) {
    if (!isAlreadyNotRunning(err) && !isLifecycleTransitionInProgress(err)) {
      // The message alone cannot classify this refusal. Daytona answers
      // "Sandbox is not in a stoppable state" both for a box it has ALREADY
      // auto-stopped and for one mid-transition — and the first is the common
      // case wherever no reaper writes `stopped` (a preview runs with
      // KORTIX_WORKERS_ENABLED=false; measured 2026-09-03: 99 of 107 pi-lab
      // sessions read `running` over boxes the provider had idled out, every
      // stop answered 5xx, and the project sat on its 100-session cap with no
      // way out through the product). Ask the provider which it is: a box that
      // is already stopped or gone IS the outcome this request wanted, so
      // reconcile our row; anything else is the failure it looks like. Same
      // rule as apps/hosting.ts `stop`.
      const providerStatus = await provider
        .getStatus(sandbox.externalId)
        .catch(() => 'unknown' as const);
      if (providerStatus !== 'stopped' && providerStatus !== 'removed') {
        return {
          status: 502,
          body: {
            error: err instanceof Error ? err.message : 'Failed to stop sandbox',
            provider_status: providerStatus,
          },
        };
      }
    }
    // Already stopped/gone on the provider side — proceed to reconcile our row.
  }

  // One stop writer for the whole platform (see applyStoppedState): it settles
  // the meter against the still-active row before flipping either status, and
  // it flips both in one transaction. This path used to inline that procedure
  // and had drifted — it assigned `{...sandbox.metadata, stoppedAt, ...}`, a
  // whole-object write built from the SELECT above, so anything a concurrent
  // writer put in that column in between was silently dropped. Two live writers
  // do exactly that (projects/routes/shared.ts clears and sets the
  // `runtimeWakeId` wake fence), and the compute clamp's `lastAliveAt` stamp
  // lives one table over for the same reason. Merged, never assigned.
  if (!cancellingWake) {
    await applyStoppedState({
      sandboxId: sandbox.sandboxId,
      sessionId,
      externalId: sandbox.externalId,
      stopReason: 'manual',
      metadata: { stoppedBy: userId },
      now,
    });
  }

  // A pi session's compute lives in a SECOND box (the environment). The worker
  // is already stopped, so this cannot be atomic. A failure must still be
  // visible to the caller: returning 200 would claim the whole session stopped
  // while the expensive environment can remain active.
  try {
    await stopSessionEnvironment(sessionId);
  } catch (err) {
    console.warn(`[session-stop] environment stop failed for ${sessionId}:`, err);
    const providerStatus =
      err && typeof err === 'object' && 'providerStatus' in err
        ? String(err.providerStatus)
        : 'unknown';
    return {
      status: 502,
      body: {
        error: 'Worker stopped but environment stop failed',
        worker_status: 'stopped',
        environment_status: providerStatus,
      },
    };
  }

  return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopped' } };
}
