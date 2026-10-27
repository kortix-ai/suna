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
 * Read by kortixd (harness/pi/config.ts): `1` allows the pi `agent` tool's `session: "separate"`
 * (a real child session, harness/pi/cloud-subagent.ts); `0` forces every call into the parent
 * session. Always set, from the `cloud_subagents` flag: a box treats an absent key as `1`. Boot-only.
 */
export const CLOUD_SUBAGENTS_ENV_NAME = 'KORTIX_PI_CLOUD_SUBAGENTS';

/** The enabled flags, sorted. */
export function featureFlagsEnvValue(metadata: unknown): string {
  const flags = Object.entries(resolveFeatureFlags(metadata))
    .filter(([, on]) => on)
    .map(([key]) => key);
  return [...flags, ...LEGACY_IMAGE_FLAGS].sort().join(',');
}

/** `{ KORTIX_PI_CLOUD_SUBAGENTS: '1' }` while the project flag is on, `'0'` while it is off. */
export function cloudSubagentsEnv(metadata: unknown): Record<string, string> {
  return { [CLOUD_SUBAGENTS_ENV_NAME]: resolveFeatureFlag(metadata, 'cloud_subagents') ? '1' : '0' };
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
