import { pauseComputeSession } from '../../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { isAlreadyNotRunning } from '../sandbox-reaper';
import { invalidateProviderCache } from '../../sandbox-proxy';

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
  if (sandbox.status !== 'active') {
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

  // Close billing FIRST (computes the wall-clock delta against the still-active
  // metering row), then flip status — same ordering as the idle reaper.
  await pauseComputeSession(sandbox.sandboxId).catch((err) =>
    console.warn(`[projects] pauseComputeSession failed for ${sandbox.sandboxId}:`, err),
  );

  const now = new Date();
  await db
    .update(sessionSandboxes)
    .set({
      status: 'stopped',
      updatedAt: now,
      metadata: {
        ...(sandbox.metadata ?? {}),
        stoppedAt: now.toISOString(),
        stoppedBy: userId,
        stopReason: 'manual',
      },
    })
    .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));
  await db
    .update(projectSessions)
    .set({ status: 'stopped', updatedAt: now })
    .where(eq(projectSessions.sessionId, sessionId));

  invalidateProviderCache(sandbox.externalId);

  return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopped' } };
}
