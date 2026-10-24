import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { resolveFeatureFlag, resolveFeatureFlags } from '../../feature-flags/registry';
import { db } from '../../shared/db';

/**
 * Read by kortixd (lib/config/feature-flags.ts) and the CLI (feature-flags.ts): the project's
 * enabled flags, comma-separated. A managed skill or CLI command behind a flag exists in the box
 * only while the flag is listed. Boot-only.
 */
export const FEATURE_FLAGS_ENV_NAME = 'KORTIX_FEATURE_FLAGS';

/**
 * Graduated keys still listed for sandbox images built before they graduated: such an image
 * withholds the kortix-genui skill unless `genui` is listed. Delete once every served image
 * is newer than 2026-10-24.
 */
const LEGACY_IMAGE_FLAGS = ['genui'];

/**
 * Read by kortixd (harness/pi/config.ts): `1` routes the pi `agent` tool to a real cloud child
 * session (harness/pi/cloud-subagent.ts). Set only while the `cloud_subagents` flag is on; absent,
 * the box keeps the in-process child. Boot-only.
 */
export const CLOUD_SUBAGENTS_ENV_NAME = 'KORTIX_PI_CLOUD_SUBAGENTS';

/** The enabled flags, sorted. */
export function featureFlagsEnvValue(metadata: unknown): string {
  const flags = Object.entries(resolveFeatureFlags(metadata))
    .filter(([, on]) => on)
    .map(([key]) => key);
  return [...flags, ...LEGACY_IMAGE_FLAGS].sort().join(',');
}

/** `{ KORTIX_PI_CLOUD_SUBAGENTS: '1' }` while the project flag is on, else no key. */
export function cloudSubagentsEnv(metadata: unknown): Record<string, string> {
  return resolveFeatureFlag(metadata, 'cloud_subagents') ? { [CLOUD_SUBAGENTS_ENV_NAME]: '1' } : {};
}

export async function buildFeatureFlagSandboxEnv(projectId: string): Promise<Record<string, string>> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return {
    [FEATURE_FLAGS_ENV_NAME]: featureFlagsEnvValue(row?.metadata),
    ...cloudSubagentsEnv(row?.metadata),
  };
}
