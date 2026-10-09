import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { config } from '../../config';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';

/** Read by kortixd (services/sandbox-env/genui-instruction.ts). Boot-only. */
export const GENUI_ENV_NAME = 'KORTIX_GENUI';

/** '1' only when the kill switch is open and the project flag is on. */
export function genuiEnvValue(metadata: unknown, enabled: boolean = config.GENUI_ENABLED): '1' | '0' {
  return enabled && resolveFeatureFlag(metadata, 'genui') ? '1' : '0';
}

export async function buildGenuiSandboxEnv(projectId: string): Promise<Record<string, string>> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return { [GENUI_ENV_NAME]: genuiEnvValue(row?.metadata) };
}
