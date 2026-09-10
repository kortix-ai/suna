import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { isLegacyPiWorkerMetadata, PI_ARTIFACT_IDENTITY_SCRIPT, recoverLegacyPiWorkerIdentity } from './pi-worker-identity-recovery';
import { piWorkerRuntimeIdentityFromSessionMetadata, type PiWorkerRuntimeIdentity } from './session-sandbox-metadata';

export async function ensurePiWorkerIdentity(input: {
  projectId: string;
  sessionId: string;
  metadata: Record<string, unknown> | null | undefined;
}): Promise<PiWorkerRuntimeIdentity | null> {
  const current = piWorkerRuntimeIdentityFromSessionMetadata(input.metadata);
  if (current || !isLegacyPiWorkerMetadata(input.metadata)) return current;
  const [sandbox] = await db.select({
    provider: sessionSandboxes.provider,
    externalId: sessionSandboxes.externalId,
    metadata: sessionSandboxes.metadata,
  }).from(sessionSandboxes).where(and(
    eq(sessionSandboxes.sandboxId, input.sessionId),
    eq(sessionSandboxes.projectId, input.projectId),
  )).limit(1);
  const identity = await recoverLegacyPiWorkerIdentity({
    projectId: input.projectId, metadata: input.metadata, sandbox: sandbox ?? null,
    readArtifact: async () => {
      const provider = getProvider('daytona');
      if (!provider.exec || !sandbox?.externalId) return null;
      const status = await provider.getStatus(sandbox.externalId);
      if (status === 'stopped') await provider.start(sandbox.externalId);
      else if (status !== 'running') return null;
      const result = await provider.exec(sandbox.externalId, [
        'node', '-e', PI_ARTIFACT_IDENTITY_SCRIPT, '/opt/kortix/session-worker.mjs',
      ], { timeoutMs: 15_000 });
      if (result.exitCode !== 0) throw new Error('Cannot read the installed Pi runtime identity');
      try { return JSON.parse(result.stdout); } catch { return null; }
    },
  });
  if (!identity) return null;
  const patch = { pi_worker_boot: true, pi_worker_ref: identity.ref, pi_worker_sha: identity.sha };
  const [updated] = await db.update(projectSessions).set({
    metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(projectSessions.sessionId, input.sessionId),
    eq(projectSessions.projectId, input.projectId),
    sql`${projectSessions.metadata}->>'sandbox_slug' = 'pi-worker'`,
    sql`not (${projectSessions.metadata} ?| array['pi_worker_boot', 'pi_worker_ref', 'pi_worker_sha'])`,
  )).returning({ metadata: projectSessions.metadata });
  if (updated) return piWorkerRuntimeIdentityFromSessionMetadata(updated.metadata);
  const [winner] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(and(
    eq(projectSessions.sessionId, input.sessionId), eq(projectSessions.projectId, input.projectId),
  )).limit(1);
  return piWorkerRuntimeIdentityFromSessionMetadata(winner?.metadata);
}
