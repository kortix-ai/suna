import { drives } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import { platinumUsRegion } from '../../shared/platinum-region';

/**
 * The region the project's `us_region` flag asks for, or `undefined` for the
 * provider's home region. Provider-neutral on purpose: it rides in
 * `CreateSandboxOpts.location`, which only the Platinum provider reads.
 *
 * The flag chooses compute placement, not API, database, or archive
 * residency. It also chooses where a project's Files are created
 * (drives/service.ts ensureProjectDrive). Where a box runs is
 * {@link resolveSessionPlacement}, which a project's Files can override.
 */
export function resolveSessionSandboxRegion(projectMetadata: unknown): string | undefined {
  if (!resolveFeatureFlag(projectMetadata, 'us_region')) return undefined;
  return platinumUsRegion() ?? undefined;
}

export interface SessionPlacement {
  /** The region a new box is created in; `undefined` = the provider's home region. */
  location: string | undefined;
  /** The box must run in `location`, with no home-region fallback: it mounts a volume of that region. */
  required: boolean;
}

/**
 * Where a new box of the project's sessions runs. Resolved at every
 * provisioning; an existing box keeps its region.
 *
 * A box mounts only volumes of its own region: Platinum refuses any other
 * (`409 volume_in_other_region`). So with Files on, every box runs where the
 * project's drive volume lives (`drives.platinum_volume_region`), whatever the
 * `us_region` flag says now. A project with no drive yet gets one where the
 * flag says, so the flag's region is the answer then too. Without Files the
 * flag decides, and the provider may fall back to the home region.
 */
export async function resolveSessionPlacement(projectId: string, projectMetadata: unknown): Promise<SessionPlacement> {
  const preferred = resolveSessionSandboxRegion(projectMetadata);
  if (!projectId || !resolveFeatureFlag(projectMetadata, 'drives')) return { location: preferred, required: false };
  const [drive] = await db
    .select({ region: drives.platinumVolumeRegion })
    .from(drives)
    .where(and(eq(drives.projectId, projectId), eq(drives.kind, 'project')))
    .limit(1);
  const location = drive ? drive.region ?? undefined : preferred;
  return { location, required: location !== undefined };
}
