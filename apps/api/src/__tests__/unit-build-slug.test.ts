import { describe, expect, it } from 'bun:test';
import {
  WARM_BUILD_SLUG_SUFFIX,
  isWarmBuildSlug,
  templateSlugFromBuildSlug,
} from '../snapshots/build-slug';

// The per-project warm baker is gone, but the `<templateSlug>-warm` rows it wrote
// to project_snapshot_builds are permanent history. These helpers still have to
// map those historical slugs back to a real template slug.
describe('warm build slug -> template slug', () => {
  it('maps a historical warm build slug back to its template slug', () => {
    expect(templateSlugFromBuildSlug('default-warm')).toBe('default');
    expect(templateSlugFromBuildSlug('custom-gpu-warm')).toBe('custom-gpu');
  });

  it('leaves a plain template slug untouched', () => {
    expect(templateSlugFromBuildSlug('default')).toBe('default');
    expect(isWarmBuildSlug('default')).toBe(false);
  });

  it('recognises the warm suffix', () => {
    expect(WARM_BUILD_SLUG_SUFFIX).toBe('-warm');
    expect(isWarmBuildSlug(`anything${WARM_BUILD_SLUG_SUFFIX}`)).toBe(true);
    expect(isWarmBuildSlug('warm')).toBe(false);
    expect(isWarmBuildSlug('warm-ish')).toBe(false);
  });

  it('strips only the trailing suffix, not an internal one', () => {
    expect(templateSlugFromBuildSlug('warm-build-warm')).toBe('warm-build');
  });
});
