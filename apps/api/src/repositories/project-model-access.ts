import { projects, projectLlmRoutingPolicies } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { modelAccessAllows, readModelAccess, updateModelAccess, type ModelAccessChange } from '../llm-gateway/model-access';

export async function getProjectModelAccess(projectId: string) {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects)
    .where(eq(projects.projectId, projectId)).limit(1);
  if (!row) throw new Error('Project not found');
  return readModelAccess(row.metadata);
}

/** Row locking prevents two switches from replacing each other's changes. */
export async function changeProjectModelAccess(input: {
  projectId: string;
  updatedBy: string;
  defaultModel: string | undefined;
  change: ModelAccessChange;
}) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ metadata: projects.metadata }).from(projects)
      .where(eq(projects.projectId, input.projectId)).for('update');
    if (!row) throw new Error('Project not found');
    const policy = updateModelAccess(readModelAccess(row.metadata), input.change);
    if (!input.change.enabled && input.defaultModel && !modelAccessAllows(policy, input.defaultModel)) {
      return { conflict: true as const };
    }
    await tx.update(projects).set({
      metadata: sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), '{model_access}', ${JSON.stringify(policy)}::jsonb)`,
      updatedAt: new Date(),
    }).where(eq(projects.projectId, input.projectId));
    // Enabling a model also makes it visible, including an older catalog model.
    // Other display preferences survive this single-model update.
    if (input.change.target === 'model' && input.change.enabled) {
      const override = { [input.change.id]: true };
      await tx.insert(projectLlmRoutingPolicies).values({
        projectId: input.projectId, modelOverrides: override, updatedBy: input.updatedBy,
      }).onConflictDoUpdate({
        target: projectLlmRoutingPolicies.projectId,
        set: { modelOverrides: sql`${projectLlmRoutingPolicies.modelOverrides} || ${JSON.stringify(override)}::jsonb`,
          updatedBy: input.updatedBy, updatedAt: new Date() },
      });
    }
    return { conflict: false as const, policy };
  });
}
