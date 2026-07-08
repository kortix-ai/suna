import { describe, expect, it } from 'bun:test';
import {
  WARM_BUILD_SLUG_SUFFIX,
  isWarmBuildSlug,
  templateSlugFromBuildSlug,
  warmBuildSlug,
} from '../snapshots/ppwarm-names';

describe('warm build slug ↔ template slug', () => {
  it('round-trips a template slug through its warm build slug', () => {
    expect(warmBuildSlug('default')).toBe('default-warm');
    expect(templateSlugFromBuildSlug(warmBuildSlug('default'))).toBe('default');
    expect(templateSlugFromBuildSlug(warmBuildSlug('custom-gpu'))).toBe('custom-gpu');
  });

  it('leaves a plain template slug untouched', () => {
    expect(templateSlugFromBuildSlug('default')).toBe('default');
    expect(isWarmBuildSlug('default')).toBe(false);
  });

  it('recognises the warm suffix', () => {
    expect(isWarmBuildSlug(`anything${WARM_BUILD_SLUG_SUFFIX}`)).toBe(true);
    expect(isWarmBuildSlug('warm')).toBe(false);
    expect(isWarmBuildSlug('warm-ish')).toBe(false);
  });

  it('strips only the trailing suffix, not an internal one', () => {
    expect(templateSlugFromBuildSlug('warm-build-warm')).toBe('warm-build');
  });

  // The regression this whole change exists for: `default-warm` reached the rebuild
  // and fix-with-agent routes as if it were a template slug, resolved to nothing,
  // and surfaced as 502 / 400 respectively.
  it('maps the build slug that broke Retry build back to a real template', () => {
    expect(templateSlugFromBuildSlug('default-warm')).toBe('default');
  });
});
