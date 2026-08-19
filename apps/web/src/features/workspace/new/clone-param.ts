/**
 * `/new?clone=<itemId>` — seed the new workspace from a `registry:project`
 * marketplace item instead of the blank starter. Replaces the removed
 * projects-index list's `clone=` query param.
 *
 * The value is passed straight through to `source_item_id`, which the API
 * type-checks against the catalogue BEFORE creating anything upstream
 * (`r1.ts`: "Resolved + type-checked BEFORE any upstream repo/DB row is
 * created"). So there is nothing to validate here beyond emptiness.
 */
export function readCloneParam(params: URLSearchParams): string | null {
  const raw = params.get('clone');
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}
