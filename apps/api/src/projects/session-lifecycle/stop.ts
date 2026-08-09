import { sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { type SandboxProviderName, config } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { isAlreadyNotRunning, isLifecycleTransitionInProgress } from '../reaping/policy';
import { applyStoppedState } from '../reaping/sandbox-state-sync';
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
  try {
    await provider.stop(sandbox.externalId);
  } catch (err) {
    if (!isAlreadyNotRunning(err) && !isLifecycleTransitionInProgress(err)) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Failed to stop sandbox' },
      };
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

  return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopped' } };
}
