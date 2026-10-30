import { projectSecretRequests, projects } from '@kortix/db';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, withDbTransaction } from '../shared/db';
import { mintSetupLink, resolveSetupLink } from './token';

/** Serialize rotation with submissions and unsets using their project lock. */
export async function mintSecretLink(
  projectId: string,
  spec: Extract<Parameters<typeof mintSetupLink>[1], { kind: 'secret' }>,
  opts?: { expiresInMinutes?: number },
) {
  return withDbTransaction(async () => {
    await db.select({ id: projects.projectId }).from(projects)
      .where(eq(projects.projectId, projectId)).limit(1).for('update');
    const minted = mintSetupLink(projectId, spec, opts);
    const resolved = resolveSetupLink(minted.token);
    if (!resolved.ok) throw new Error('Could not resolve newly minted secret link');
    const nonce = resolved.payload.nonce;
    await db.insert(projectSecretRequests).values(spec.fields.map(({ name }) => ({
      projectId, name, nonce,
    }))).onConflictDoUpdate({
      target: [projectSecretRequests.projectId, projectSecretRequests.name],
      set: { nonce },
    });
    return minted;
  });
}

/** Missing markers preserve legacy links until the first rotation of their key. */
export async function secretLinkSuperseded(projectId: string, names: string[], nonce: string): Promise<boolean> {
  const rows = await db.select({ name: projectSecretRequests.name }).from(projectSecretRequests)
    .where(and(eq(projectSecretRequests.projectId, projectId), inArray(projectSecretRequests.name, names), ne(projectSecretRequests.nonce, nonce)))
    .limit(1);
  return rows.length > 0;
}
