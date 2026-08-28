/**
 * Build-log slug helpers.
 *
 * `project_snapshot_builds.slug` records `<templateSlug>-warm` for rows written
 * by the per-project warm-image baker. That system is gone, but its rows are
 * permanent history, and the build-log API, the template resolver (Retry build /
 * Fix with agent) and the session build list all round-trip every slug through
 * these helpers. They must outlive the baker.
 */

/** Suffix the retired warm baker appended to a template slug for its build rows. */
export const WARM_BUILD_SLUG_SUFFIX = '-warm';

export function isWarmBuildSlug(slug: string): boolean {
  return slug.endsWith(WARM_BUILD_SLUG_SUFFIX);
}

/**
 * Map a build-log slug back to the template slug it was baked from. Ambiguous by
 * construction: a project MAY declare a real template literally named `foo-warm`.
 * Callers must therefore try the slug verbatim FIRST and only fall back to this —
 * see `resolveTemplateForBuildSlug`.
 */
export function templateSlugFromBuildSlug(buildSlug: string): string {
  return isWarmBuildSlug(buildSlug)
    ? buildSlug.slice(0, -WARM_BUILD_SLUG_SUFFIX.length)
    : buildSlug;
}
