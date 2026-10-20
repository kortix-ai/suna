import { projects, projectLlmRoutingPolicies, projectSecrets } from '@kortix/db';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { db } from '../shared/db';
import { modelAccessAllows, readModelAccess, updateModelAccess, type ModelAccessChange } from '../llm-gateway/model-access';
import {
  CUSTOM_PROVIDERS_METADATA_KEY,
  type CustomLlmProviderDefinition,
  type CustomLlmProviderInput,
  readCustomProviders,
  upsertCustomProvider,
} from '../llm-gateway/custom-providers';

export async function getProjectModelAccess(projectId: string) {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects)
    .where(eq(projects.projectId, projectId)).limit(1);
  if (!row) throw new Error('Project not found');
  return readModelAccess(row.metadata);
}

/** Read model access, the pooled flag and custom providers from one projects row (KRTX-586). */
export async function getProjectGatewayResolution(projectId: string) {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects)
    .where(eq(projects.projectId, projectId)).limit(1);
  if (!row) throw new Error('Project not found');
  return {
    access: readModelAccess(row.metadata),
    pooledEnabled: resolveFeatureFlag(row.metadata, 'pooled_provider_secrets'),
    customProviders: readCustomProviders(row.metadata),
  };
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

/** The project's custom providers and the names of its project-wide `CUSTOM_*_API_KEY` secrets. */
export async function listProjectCustomProviders(projectId: string) {
  const [[row], secrets] = await Promise.all([
    db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, projectId)).limit(1),
    db.select({ name: projectSecrets.name }).from(projectSecrets).where(and(
      eq(projectSecrets.projectId, projectId),
      isNull(projectSecrets.ownerUserId),
      like(projectSecrets.name, 'CUSTOM\\_%\\_API\\_KEY'),
    )),
  ]);
  return { providers: readCustomProviders(row?.metadata), secretNames: secrets.map((secret) => secret.name) };
}

/**
 * Create, replace (`input`) or remove (`null`) one custom provider. Row-locked
 * like `changeProjectModelAccess`, so two writes never drop each other's entry.
 * Returns null when removing an id that does not exist.
 */
export async function writeProjectCustomProvider(
  projectId: string,
  id: string,
  input: CustomLlmProviderInput | null,
): Promise<CustomLlmProviderDefinition[] | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ metadata: projects.metadata }).from(projects)
      .where(eq(projects.projectId, projectId)).for('update');
    if (!row) throw new Error('Project not found');
    const current = readCustomProviders(row.metadata);
    if (!input && !current.some((provider) => provider.id === id)) return null;
    const next = input ? upsertCustomProvider(current, id, input) : current.filter((provider) => provider.id !== id);
    await tx.update(projects).set({
      metadata: sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), ${`{${CUSTOM_PROVIDERS_METADATA_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb)`,
      updatedAt: new Date(),
    }).where(eq(projects.projectId, projectId));
    return next;
  });
}
