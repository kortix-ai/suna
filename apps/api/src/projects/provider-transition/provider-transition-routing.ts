/** Routing read-model for the sandbox-provider migration (the project metadata
 *  keys activation writes + `readActiveRouting`), split out of
 *  provider-transition-store.ts so the platform session-sandbox service imports
 *  this instead of the transition store. */
import { eq } from 'drizzle-orm';
import { projects, type Database } from '@kortix/db';

export const PIN_META_KEY = 'default_sandbox_provider';
export const ACTIVE_EXTERNAL_ID_META_KEY = 'active_sandbox_external_template_id';
/** FIX-K-lite: the exact ppwarm image NAME activation pinned. Written together
 *  with the external id (activation only), so the snapshot-GC pinned-image guard
 *  can cross-check reap targets by NAME — the id activation records is the
 *  provider's external template id, not the `kortix-ppwarm-…` name the reaper
 *  deletes by. A stale build MARKER can overwrite the transition marker's
 *  snapshot_name, but this key is touched ONLY on activation, so it stays a
 *  reliable record of the live pinned image. */
export const ACTIVE_SNAPSHOT_NAME_META_KEY = 'active_sandbox_snapshot_name';
/** Compact marker mirrored into project metadata so the existing project
 *  response (which passes `metadata` through) is pollable without a schema
 *  change to @kortix/api-contract. */
export const TRANSITION_META_KEY = 'sandbox_provider_transition';

function asMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

export interface ActiveRouting {
  /** The pin routing uses. Written ONLY at activation — never the in-flight
   *  target of a not-yet-activated transition. null ⇒ follow platform default. */
  activeProvider: string | null;
  /** The exact provider template id activation pinned. Boot should pin by this. */
  activeExternalTemplateId: string | null;
  /** The exact image name associated with activeExternalTemplateId. */
  activeSnapshotName: string | null;
  generation: number;
}

/**
 * Recover the image name written by provider-transition activations that
 * predate ACTIVE_SNAPSHOT_NAME_META_KEY. The legacy marker is usable only when
 * every routing identity still matches the current project row. A later
 * transition marker can overwrite this nested object, so any mismatch must
 * fail closed to name boot.
 */
function recoverLegacyActiveSnapshotName(
  meta: Record<string, unknown>,
  activeProvider: string | null,
  activeExternalTemplateId: string | null,
  generation: number,
): string | null {
  if (!activeProvider || !activeExternalTemplateId) return null;
  const marker = asMeta(meta[TRANSITION_META_KEY]);
  const snapshotName = marker.snapshot_name;
  if (
    marker.status !== 'activated' ||
    marker.target_provider !== activeProvider ||
    marker.external_template_id !== activeExternalTemplateId ||
    marker.generation !== generation ||
    typeof snapshotName !== 'string' ||
    snapshotName.length === 0
  ) {
    return null;
  }
  return snapshotName;
}

/**
 * Read the active routing identity from a SINGLE project row — pin + activated
 * external template id and image name are written together in the activation
 * transaction, so a single row read gets them atomically. No path may derive the
 * active provider from an in-flight transition.
 */
export async function readActiveRouting(db: Database, projectId: string): Promise<ActiveRouting | null> {
  const [row] = await db
    .select({ metadata: projects.metadata, generation: projects.sandboxProviderGeneration })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row) return null;
  const meta = asMeta(row.metadata);
  const pin = meta[PIN_META_KEY];
  const extId = meta[ACTIVE_EXTERNAL_ID_META_KEY];
  const activeProvider = typeof pin === 'string' ? pin : null;
  const activeExternalTemplateId = typeof extId === 'string' ? extId : null;
  const generation = row.generation ?? 0;
  const currentSnapshotName = meta[ACTIVE_SNAPSHOT_NAME_META_KEY];
  const activeSnapshotName =
    typeof currentSnapshotName === 'string'
      ? currentSnapshotName
      : recoverLegacyActiveSnapshotName(meta, activeProvider, activeExternalTemplateId, generation);
  return {
    activeProvider,
    activeExternalTemplateId,
    activeSnapshotName,
    generation,
  };
}
