import { createHash } from 'node:crypto';

/**
 * Naming + reap-selection for per-project COLD warm images (`kortix-ppwarm-…`),
 * the cold, provider-agnostic analogue of prod's stateful `kortix-wproj-`
 * snapshots. Pure — NO config/env/provider imports — so the selection logic is
 * unit-testable without booting the server.
 */

export const PPWARM_PREFIX = 'kortix-ppwarm-';

/**
 * First 8 hex chars of the projectId with dashes stripped — the per-project scope
 * key in a ppwarm name. Matches warm-project.ts's `proj8` so the prefixes line up.
 */
export function proj8(projectId: string): string {
  return projectId.replace(/-/g, '').slice(0, 8);
}

/**
 * Content-addressed name for a project's COLD warm image, keyed on
 * (project, tip, base runtime identity). A new tip OR a runtime-fingerprint bump
 * moves the name → a fresh bake; a stale name is never served for a moved tip.
 * Mirrors warm-project.ts's `kortix-wproj-<proj8>-<hash12>` naming.
 */
export function perProjectWarmImageName(projectId: string, tip: string, baseSnapshotName: string): string {
  const hash = createHash('sha256').update(`${projectId}|${tip}|${baseSnapshotName}`).digest('hex').slice(0, 12);
  return `${PPWARM_PREFIX}${proj8(projectId)}-${hash}`;
}

/**
 * Pure selector for the on-bake reap: given every snapshot/template name the
 * provider knows, return this project's SUPERSEDED per-project warm names — those
 * under the project's `kortix-ppwarm-<proj8>-` prefix that are NOT the current
 * tip. proj8-scoped so it can never match another project; the shared base
 * (`kortix-default-…`) never carries the ppwarm prefix so it's never a target;
 * returns [] when only the current tip exists (idempotent re-bake). Tombstones
 * are excluded: Platinum's delete is a soft-delete that renames the row to
 * `…__deleted_<id>` while KEEPING the ppwarm prefix, so an already-reaped tip
 * would otherwise be re-selected (and re-DELETEd) on every later bake; those rows
 * are already deprecated / not quota-counting, so there is nothing to reap.
 */
export function ppwarmReapTargets(projectId: string, currentName: string, allNames: string[]): string[] {
  const prefix = `${PPWARM_PREFIX}${proj8(projectId)}-`;
  return allNames.filter((n) => n.startsWith(prefix) && n !== currentName && !n.includes('__deleted'));
}
