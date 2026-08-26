import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import { resolveFeatureFlag } from '../feature-flags/registry';

/** True only when the platform gateway is available and this project opted in. */
export function projectLlmGatewayEnabled(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'llm_gateway');
}

/**
 * Same decision, by project id. One indexed read of `projects.metadata` —
 * for callers that don't already hold the project row. Fails CLOSED (native
 * OpenCode mode) on a missing project: native is the flag-off default and the
 * only mode that cannot silently spend platform credits.
 */
export async function projectLlmGatewayEnabledById(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return projectLlmGatewayEnabled(row?.metadata);
}
