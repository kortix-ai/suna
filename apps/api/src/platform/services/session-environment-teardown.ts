/**
 * Taking a session environment down.
 *
 * Split from `session-environment.ts` because teardown and provisioning have
 * wildly different dependency graphs. Bringing an environment UP needs the
 * image builder, the git layer, the manifest schema and the agent-config
 * compiler; taking one DOWN needs a provider handle, the metering ledger, and
 * one table. The maintenance tick (`reaping/orphan-environments.ts`) is a
 * teardown-only consumer, and without this split importing it pulled the whole
 * provisioning graph into every API process to run a delete.
 *
 * `session-environment.ts` re-exports both functions, so this move is invisible
 * to callers.
 */
import { eq } from 'drizzle-orm';
import { sessionEnvironments } from '@kortix/db';
import { db } from '../../shared/db';
import { getDaytona } from '../../shared/daytona';
import { withTimeout } from '../../shared/with-timeout';
import { endComputeSession } from '../../billing/services/compute-metering';
import type { SessionEnvironmentInfo } from './session-environment-types';

const PROVIDER_CALL_TIMEOUT_MS = 30_000;

async function readRow(sessionId: string) {
  const [row] = await db
    .select()
    .from(sessionEnvironments)
    .where(eq(sessionEnvironments.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/** Stop the environment box; the row survives for a later resume. */
export async function stopSessionEnvironment(sessionId: string): Promise<SessionEnvironmentInfo | null> {
  const row = await readRow(sessionId);
  if (!row) return null;
  if (row.externalId && row.status === 'active') {
    try {
      const daytona = getDaytona();
      const sandbox = await withTimeout(
        daytona.get(row.externalId),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona get(${row.externalId})`,
      );
      await withTimeout(
        (daytona as unknown as { stop(sandbox: unknown): Promise<unknown> }).stop(sandbox),
        60_000,
        `Daytona stop(${row.externalId})`,
      );
    } catch (err) {
      console.warn(`[session-env] stop of ${row.externalId} failed:`, err);
    }
  }
  // Close the meter with the box. `environmentId` is the compute row's
  // sandbox id (the provider's externalId is a different value).
  const meteredId = (row.metadata as { environmentId?: string } | null)?.environmentId;
  if (meteredId) await endComputeSession(meteredId).catch(() => {});
  const [updated] = await db
    .update(sessionEnvironments)
    .set({ status: 'stopped', updatedAt: new Date() })
    .where(eq(sessionEnvironments.sessionId, sessionId))
    .returning();
  return updated
    ? { sessionId, status: updated.status, externalId: updated.externalId, previewUrl: null, previewToken: null }
    : null;
}

/**
 * Retire a session's environment for good: power the box off and drop the row.
 *
 * Sessions are soft-deleted (`metadata.deletedAt`), so nothing cascades to this
 * table — before this, a deleted session left its environment box behind with
 * only the provider's 60 s idle timer to stop it and NOTHING to ever delete it.
 * Best-effort on the provider call: a box we cannot reach must still lose its
 * row, or it becomes invisible AND permanent.
 */
export async function deleteSessionEnvironment(sessionId: string): Promise<void> {
  const row = await readRow(sessionId);
  if (!row) return;
  const meteredId = (row.metadata as { environmentId?: string } | null)?.environmentId;
  if (meteredId) await endComputeSession(meteredId).catch(() => {});
  if (row.externalId) {
    try {
      const daytona = getDaytona();
      const sandbox = await withTimeout(
        daytona.get(row.externalId),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona get(${row.externalId})`,
      );
      await withTimeout(
        (daytona as unknown as { delete(sandbox: unknown): Promise<unknown> }).delete(sandbox),
        60_000,
        `Daytona delete(${row.externalId})`,
      );
    } catch (err) {
      console.warn(`[session-env] delete of ${row.externalId} failed:`, err);
    }
  }
  await db.delete(sessionEnvironments).where(eq(sessionEnvironments.sessionId, sessionId));
}
