#!/usr/bin/env bun
/**
 * Dev release gate. Deploy Dev runs this inside the NEW API image, with the
 * exact task environment the ECS roll is about to register, BEFORE the roll.
 *
 *   1. Build the Platinum platform default image this API version computes,
 *      unpublished: the version still serving keeps its template row and its
 *      snapshot (see `buildPlatformDefaultImageForRelease`).
 *   2. Build the meta image (My Kortix sessions) this API version computes, in
 *      parallel. Its reap protects the image the serving version boots.
 *   3. When KORTIX_PLATINUM_US_REGION is set, make both images resident in the
 *      US region and wait until Platinum proves it.
 *
 * After the roll, the first session in either region boots the exact image of
 * the API version that serves it: no last-ready fallback, no legacy runtime
 * bootstrap, no inline meta build, and no EU→US copy on a US session's create
 * path.
 *
 * Exit 0 when both images are ready (and resident, when a US region is set), or
 * when Platinum is not enabled. Exit 1 otherwise, after a GitHub warning. The
 * workflow step never blocks the roll on this exit code (continue-on-error);
 * a failure only means the next deploy behaves as it did before this gate.
 */
import { config } from '../src/config';
import { platinumUsRegion } from '../src/shared/platinum-region';
import { buildPlatformDefaultImageForRelease, ensureMyKortixSandboxImage } from '../src/snapshots/builder';
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
  // allSettled: a failed meta build must not kill the default build mid-flight
  // through process.exit, and the other way round.
  const builds = await Promise.allSettled([
    buildPlatformDefaultImageForRelease('platinum'),
    ensureMyKortixSandboxImage({ source: 'startup', provider: 'platinum' }),
  ]);
  const ready: string[] = [];
  const failures: string[] = [];
  builds.forEach((build, index) => {
    const label = index === 0 ? 'platform default' : 'My Kortix';
    if (build.status === 'rejected') {
      failures.push(`${label}: ${build.reason instanceof Error ? build.reason.message : String(build.reason)}`);
      return;
    }
    ready.push(build.value.snapshotName);
    console.log(
      `[release-gate] ${label} ${build.value.snapshotName} ${build.value.built ? 'built' : 'already active'} in ${seconds(buildStarted)}`,
    );
  });

  const region = platinumUsRegion();
  if (!region) {
    console.log(
      '[release-gate] KORTIX_PLATINUM_US_REGION is not set; no regional residency to prepare',
    );
  } else {
    const prepareStarted = Date.now();
    const resident = await Promise.allSettled(
      ready.map((name) =>
        preparePlatinumTemplateRegion(name, region, { timeoutMs: PREPARE_DEADLINE_MS }).then((r) => ({ name, ...r })),
      ),
    );
    resident.forEach((r, index) => {
      if (r.status === 'rejected') {
        failures.push(`${ready[index]} residency: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        return;
      }
      console.log(
        `[release-gate] ${r.value.name} (template ${r.value.templateId}) resident in ${r.value.region} after ${seconds(prepareStarted)}`,
      );
    });
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
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
