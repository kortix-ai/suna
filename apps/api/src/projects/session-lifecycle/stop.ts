import { config, type SandboxProviderName } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { isAlreadyNotRunning } from '../reaping/policy';
import { applyStoppedState } from '../reaping/sandbox-state-sync';

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
    const [session] = await db
      .select({ status: projectSessions.status })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.sessionId, sessionId),
          eq(projectSessions.projectId, projectId),
          eq(projectSessions.accountId, accountId),
        ),
      )
      .limit(1);
    if (session && ['queued', 'branching', 'provisioning'].includes(session.status)) {
      await db
        .update(projectSessions)
        .set({ status: 'stopped', updatedAt: new Date() })
        .where(
          and(
            eq(projectSessions.sessionId, sessionId),
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.accountId, accountId),
          ),
        );
      return {
        status: 409,
        body: {
          error: 'Session is still provisioning',
          status: 'provisioning',
          retryable: true,
        },
      };
    }
    return { status: 404, body: { error: 'Session sandbox not found' } };
  }
  if (sandbox.status === 'archived') {
    return { status: 404, body: { error: 'Session sandbox not found' } };
  }
  if (sandbox.status === 'stopped') {
    return {
      status: 409,
      body: { error: 'Session is not running', status: 'stopped' },
    };
  }
  if (sandbox.status === 'error' && !sandbox.externalId) {
    // Provisioning failed before a provider runtime existed. Reconcile the
    // logical rows to the same stopped terminal state as a provider-confirmed
    // stop; there is no external process left to stop.
    const now = new Date();
    await applyStoppedState({
      sandboxId: sandbox.sandboxId,
      sessionId,
      externalId: null,
      metadata: { stoppedAt: now.toISOString(), stoppedBy: userId, stopReason: 'manual' },
      now,
    });
    return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopped' } };
  }
  if (sandbox.status === 'provisioning' && !sandbox.externalId) {
    // Fence the logical session before returning. The provisioning controller
    // checks this server-owned state before publishing its provider result. The
    // durable stop command remains queued until the sandbox row becomes stopped.
    await db
      .update(projectSessions)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(
        and(
          eq(projectSessions.sessionId, sessionId),
          eq(projectSessions.projectId, projectId),
          eq(projectSessions.accountId, accountId),
        ),
      );
    return {
      status: 409,
      body: {
        error: 'Session is still provisioning',
        status: 'provisioning',
        retryable: true,
      },
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
  try {
    await provider.stop(sandbox.externalId);
  } catch (err) {
    if (!isAlreadyNotRunning(err)) {
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
  const now = new Date();
  await applyStoppedState({
    sandboxId: sandbox.sandboxId,
    sessionId,
    externalId: sandbox.externalId,
    metadata: { stoppedAt: now.toISOString(), stoppedBy: userId, stopReason: 'manual' },
    now,
  });

  return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopped' } };
}
