import { platinumUsRegion } from '../shared/platinum-region';
import { preparePlatinumTemplateRegion } from './providers/platinum-templates';
import { logger } from '../lib/logger';

/**
 * Make a platform image resident in the configured US region as soon as it is
 * built, instead of when the first `us_region` session asks for it.
 *
 * Without this, the first US session after every new image waits while
 * Platinum copies the template from its home region (`409
 * template_not_resident`, waited out in platinum.ts). Measured on Platinum
 * prod, 2026-10-08: 64 s, 107 s and 213 s for three Kortix images. A self-host
 * builds a new image after each update, so that wait recurs.
 *
 * Best-effort. A failure is logged and the on-demand copy at session create
 * stays the fallback. Platinum copies at most once per (template, region), so
 * a second call, or the dev release gate's own prepare, only observes it.
 */
export type UsRegionResidencyOutcome = 'skipped' | 'resident' | 'failed';

export async function prepareUsRegionResidency(
  providerId: string,
  snapshotName: string,
  deps: { prepare?: typeof preparePlatinumTemplateRegion } = {},
): Promise<UsRegionResidencyOutcome> {
  const region = platinumUsRegion();
  if (providerId !== 'platinum' || !region) return 'skipped';
  const prepare = deps.prepare ?? preparePlatinumTemplateRegion;
  const started = Date.now();
  try {
    const resident = await prepare(snapshotName, region);
    logger.info('[snapshots] platform image resident in the US region', {
      snapshotName,
      templateId: resident.templateId,
      region: resident.region,
      durationMs: Date.now() - started,
    });
    return 'resident';
  } catch (err) {
    logger.warn('[snapshots] platform image not made resident in the US region; the first session there waits for the copy', {
      snapshotName,
      region,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
