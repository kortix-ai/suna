// Shared project-secret plumbing for the chat-channel installs. Each platform
// owns its install rows and secret keys in its own module (slack/installs.ts,
// email/installs.ts, teams/installs.ts); this module owns the shared secret
// upsert/read/delete plumbing and re-exports the platform modules, so the
// established '../install-store' and `channels` import paths keep working.
//
// The cycle (a platform module importing this module while this module
// re-exports it) is safe: every shared helper is a hoisted function
// declaration, and the platform modules touch those helpers only at call time,
// long after both sides of the cycle have finished evaluating.
import { chatInstalls, projectSecrets } from '@kortix/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decryptProjectSecret, encryptProjectSecret, getProjectSecretValueForConsumer } from '../projects/secrets';

// The email inbox accounts encrypt their credential with the project key
// (channels/email/installs.ts); they reach it here, the channels' one door
// into project secrets.
export { decryptProjectSecret as decryptChannelSecret, encryptProjectSecret as encryptChannelSecret };
import { db } from '../shared/db';

export * from './slack/installs';
export * from './email/installs';
export * from './teams/installs';
export * from './telegram/installs';

export async function deleteProjectSecrets(
  projectId: string,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), inArray(projectSecrets.name, [...names])));
}

export async function listProjectsForWorkspace(
  platform: string,
  workspaceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, platform), eq(chatInstalls.workspaceId, workspaceId)));
  return rows.map((r) => r.projectId);
}

export async function upsertSecret(projectId: string, name: string, value: string): Promise<void> {
  const valueEnc = encryptProjectSecret(projectId, value);
  const updated = await updateSharedSecret(projectId, name, valueEnc);
  if (updated) return;

  try {
    await db.insert(projectSecrets).values({
      projectId,
      identifier: name,
      name,
      valueEnc,
      scope: 'connector',
      strategy: 'broker',
      consumer: 'connector',
      rotatedAt: new Date(),
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
    const retryUpdated = await updateSharedSecret(projectId, name, valueEnc);
    if (!retryUpdated) throw err;
  }
}

async function updateSharedSecret(
  projectId: string,
  name: string,
  valueEnc: string,
): Promise<boolean> {
  const rows = await db
    .update(projectSecrets)
    .set({
      valueEnc,
      scope: 'connector',
      strategy: 'broker',
      consumer: 'connector',
      egressPolicy: null,
      handlePrefix: null,
      active: true,
      rotatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, name),
        isNull(projectSecrets.ownerUserId),
      ),
    )
    .returning({ secretId: projectSecrets.secretId });
  return rows.length > 0;
}

function isUniqueConflict(err: unknown): boolean {
  const error = err as {
    code?: unknown;
    cause?: { code?: unknown; cause?: { code?: unknown } };
  };
  return (
    error?.code === '23505' ||
    error?.cause?.code === '23505' ||
    error?.cause?.cause?.code === '23505'
  );
}

export async function readSecret(projectId: string, name: string): Promise<string | null> {
  return getProjectSecretValueForConsumer({
    projectId,
    name,
    consumer: 'connector',
    probe: true, // install lookups are system probes, not access by an agent or person
  });
}
