import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { config } from '../../config';
import { resolveFeatureFlag, resolveFeatureFlags } from '../../feature-flags/registry';
import { db } from '../../shared/db';

/** Read by kortixd (lib/config/genui.ts): 1 lists the kortix-genui system skill. Boot-only. */
export const GENUI_ENV_NAME = 'KORTIX_GENUI';

/**
 * Read by kortixd (lib/config/feature-flags.ts) and the CLI (feature-flags.ts): the project's
 * enabled flags, comma-separated. A managed skill or CLI command behind a flag exists in the box
 * only while the flag is listed. Boot-only.
 */
export const FEATURE_FLAGS_ENV_NAME = 'KORTIX_FEATURE_FLAGS';

/**
 * Read by kortixd (harness/pi/config.ts): `1` routes the pi `agent` tool to a real cloud child
 * session (harness/pi/cloud-subagent.ts). Set only while the `cloud_subagents` flag is on; absent,
 * the box keeps the in-process child. Boot-only.
 */
export const CLOUD_SUBAGENTS_ENV_NAME = 'KORTIX_PI_CLOUD_SUBAGENTS';

/** '1' only when the kill switch is open and the project flag is on. */
export function genuiEnvValue(metadata: unknown, enabled: boolean = config.GENUI_ENABLED): '1' | '0' {
  return enabled && resolveFeatureFlag(metadata, 'genui') ? '1' : '0';
}

/** The enabled flags, sorted; `genui` follows the kill switch too. */
export function featureFlagsEnvValue(metadata: unknown, genuiKillSwitchOpen: boolean = config.GENUI_ENABLED): string {
  const flags = resolveFeatureFlags(metadata);
  flags.genui = genuiEnvValue(metadata, genuiKillSwitchOpen) === '1';
  return Object.entries(flags)
    .filter(([, on]) => on)
    .map(([key]) => key)
    .sort()
    .join(',');
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
    [GENUI_ENV_NAME]: genuiEnvValue(row?.metadata),
    [FEATURE_FLAGS_ENV_NAME]: featureFlagsEnvValue(row?.metadata),
    ...cloudSubagentsEnv(row?.metadata),
  };
}
