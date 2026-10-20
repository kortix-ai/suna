import { projectSecretTombstones, projects } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../shared/db';
import { mintSetupLink } from './token';

/** Serialize re-mints with unset and intake submissions on the project row. */
export async function mintSecretRequest(
  projectId: string,
  spec: Extract<Parameters<typeof mintSetupLink>[1], { kind: 'secret' }>,
  expiresInMinutes?: number,
): Promise<ReturnType<typeof mintSetupLink>> {
  return withDbTransaction(async () => {
    const { fields } = spec;
    await db.select({ id: projects.projectId }).from(projects)
      .where(eq(projects.projectId, projectId)).for('update');
    const previous = await db.select({ at: projectSecretTombstones.deletedAt })
      .from(projectSecretTombstones).where(and(
        eq(projectSecretTombstones.projectId, projectId),
        inArray(projectSecretTombstones.name, fields.map((field) => field.name)),
      ));
    // Advance past the last mint even when two requests share a millisecond.
    const mintedAt = Math.max(Date.now(), ...previous.map((row) => row.at.getTime() + 1));
    for (const field of fields) {
      await db.insert(projectSecretTombstones)
        .values({ projectId, name: field.name, deletedAt: new Date(mintedAt) })
        .onConflictDoUpdate({
          target: [projectSecretTombstones.projectId, projectSecretTombstones.name],
          set: { deletedAt: new Date(mintedAt) },
        });
    }
    return mintSetupLink(projectId, spec, { expiresInMinutes, mintedAt });
  });
}
