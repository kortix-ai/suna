import { eq } from 'drizzle-orm';

import { resolveFeatureFlag, resolveFeatureFlags } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import { isPlatinumConfigured } from '../../shared/platinum';
import { projectsView } from '../../workspaces/rows';

/**
 * Read by kortixd (lib/config/feature-flags.ts) and the CLI (feature-flags.ts): the project's
 * enabled flags, comma-separated. A managed skill or CLI command behind a flag exists in the box
 * only while the flag is listed. Boot-only.
 */
export const FEATURE_FLAGS_ENV_NAME = 'KORTIX_FEATURE_FLAGS';

/** kortixd's cap on nested separate sessions (harness/pi/config.ts); its default is 2. */
const SUBAGENT_MAX_DEPTH_ENV_NAME = 'KORTIX_PI_CLOUD_SUBAGENTS_MAX_DEPTH';
/** A talk-only front (`chat_front`) is one level above its worker: one more level keeps the worker's own subagents. */
const FRONT_THREAD_MAX_DEPTH = 3;

/**
 * Graduated keys still listed for sandbox images built before they graduated: such an image
 * withholds the kortix-genui skill unless `genui` is listed. Delete once every served image
 * is newer than 2026-10-24.
 */
const LEGACY_IMAGE_FLAGS = ['genui'];

/**
 * Graduated and still listed wherever the platform stores a Drive: boxes, CLIs
 * and managed skills built before then gate these features on them. `drives`
 * and `volumes` graduated 2026-11-02; `artifacts` (paths in the Drive)
 * 2026-11-06: an older image withholds the kortix-artifacts skill and an older
 * CLI hides `kortix artifacts` unless it is listed.
 */
const DRIVE_FLAGS = ['artifacts', 'drives', 'volumes'];

/** The enabled flags, sorted. */
export function featureFlagsEnvValue(metadata: unknown): string {
  const flags = Object.entries(resolveFeatureFlags(metadata))
    .filter(([, on]) => on)
    .map(([key]) => key);
  return [...flags, ...LEGACY_IMAGE_FLAGS, ...(isPlatinumConfigured() ? DRIVE_FLAGS : [])].sort().join(',');
}

export async function buildFeatureFlagSandboxEnv(projectId: string): Promise<Record<string, string>> {
  const [row] = await db
    .select({ metadata: projectsView.metadata })
    .from(projectsView)
    .where(eq(projectsView.projectId, projectId))
    .limit(1);
  return {
    [FEATURE_FLAGS_ENV_NAME]: featureFlagsEnvValue(row?.metadata),
    ...(resolveFeatureFlag(row?.metadata, 'chat_front') ? { [SUBAGENT_MAX_DEPTH_ENV_NAME]: String(FRONT_THREAD_MAX_DEPTH) } : {}),
  };
}
