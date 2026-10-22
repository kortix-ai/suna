#!/usr/bin/env bun
/**
 * Dev release gate. Deploy Dev runs this inside the NEW API image, with the
 * exact task environment the ECS roll is about to register, BEFORE the roll.
 *
 *   1. Build the Platinum platform default image this API version computes,
 *      unpublished: the version still serving keeps its template row and its
 *      snapshot (see `buildPlatformDefaultImageForRelease`).
 *   2. When KORTIX_PLATINUM_US_REGION is set, make that image resident in the
 *      US region and wait until Platinum proves it.
 *
 * After the roll, the first session in either region boots the exact image of
 * the API version that serves it: no last-ready fallback, no legacy runtime
 * bootstrap, and no EU→US copy on a US session's create path.
 *
 * Exit 0 when the image is ready (and resident, when a US region is set), or
 * when Platinum is not enabled. Exit 1 otherwise, after a GitHub warning. The
 * workflow step never blocks the roll on this exit code (continue-on-error);
 * a failure only means the next deploy behaves as it did before this gate.
 */
import { config } from '../src/config';
import { platinumUsRegion } from '../src/shared/platinum-region';
import { buildPlatformDefaultImageForRelease } from '../src/snapshots/builder';
import { preparePlatinumTemplateRegion } from '../src/snapshots/providers/platinum-templates';

/** Longest observed EU→US copy of a Kortix image (2026-10-02) was 255 s. */
const PREPARE_DEADLINE_MS = 12 * 60_000;

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  if (!config.isPlatinumEnabled()) {
    console.log('[release-gate] Platinum is not enabled in this environment; nothing to prepare');
    return;
  }
  const buildStarted = Date.now();
  const image = await buildPlatformDefaultImageForRelease('platinum');
  console.log(
    `[release-gate] platform default ${image.snapshotName} ${image.built ? 'built' : 'already active'} in ${seconds(buildStarted)}`,
  );

  const region = platinumUsRegion();
  if (!region) {
    console.log(
      '[release-gate] KORTIX_PLATINUM_US_REGION is not set; no regional residency to prepare',
    );
    return;
  }
  const prepareStarted = Date.now();
  const resident = await preparePlatinumTemplateRegion(image.snapshotName, region, {
    timeoutMs: PREPARE_DEADLINE_MS,
  });
  console.log(
    `[release-gate] ${image.snapshotName} (template ${resident.templateId}) resident in ${resident.region} after ${seconds(prepareStarted)}`,
  );
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    const message = (err instanceof Error ? err.message : String(err))
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 500);
    console.log(`::warning title=Dev release gate::${message}`);
    process.exit(1);
  },
);
