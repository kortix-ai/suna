/**
 * Rule 4 — admission control (the runtime-convergence contract (PR #7785)).
 *
 * "Before a box is handed to a session, it must prove its runtime identity —
 * `config.release.v1` present, `daemon_build >= floor`, `catalog_fingerprint`
 * current. A box that fails admission is replaced, not used. The floor is a
 * constant in the API, raised deliberately, never read from the box."
 *
 * This is the part that makes the top-of-file promise hold for every session
 * from the moment it ships, independent of every box that already exists —
 * see the incident this closes: a box whose boot-time managed-model fetch
 * failed kept the daemon's bundled lineup for 30 days, and after the platform
 * lineup rotated it had no model either side would accept.
 *
 * `evaluateAdmission` is pure and total: every input is already-parsed data
 * (this module never fetches a health endpoint itself — see
 * `admitSandboxForSession` in ./admit-sandbox.ts for the wrapper that reads
 * `GET /kortix/health` and calls this).
 */

/**
 * The monotonic daemon-build floor. Raised deliberately by a human when a new
 * daemon build ships a capability a session must not run without — NEVER
 * derived from anything a box reports (a box that predates a capability
 * cannot be trusted to know it predates it). `0` admits every build that
 * reports a build number at all; it is intentionally low until an incident or
 * a shipped capability justifies raising it, exactly like
 * `RUNTIME_ASSETS_BUILD` is an override, not a default.
 *
 * OPERATOR RUNBOOK: raise this via `dotenvx set RUNTIME_ADMISSION_MIN_DAEMON_BUILD
 * <n> -f apps/api/.env` and redeploy — it is read at module load, not live, so a
 * raise takes effect on the next deploy, matching `daemon_build`'s own
 * once-per-process derivation in runtime-assets/manifest.ts.
 */
function parseMinDaemonBuild(): number {
  const raw = process.env.RUNTIME_ADMISSION_MIN_DAEMON_BUILD?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export const MIN_DAEMON_BUILD = parseMinDaemonBuild();

/**
 * Is this refusal fixable IN PLACE, or does the box have to be replaced?
 *
 * Rule 4 said "a box that fails admission is replaced, not used", and that is
 * right for a box that cannot be brought up to date at all — one that does not
 * speak `config.release.v1`, or whose daemon predates the floor. Nothing we can
 * do over HTTP changes either.
 *
 * A STALE CATALOG is not that. The platform already has a converger for it
 * (`POST /kortix/catalog/converge`, driven by `convergeSandboxModelCatalog`),
 * it takes seconds, and the fingerprint legitimately lags for a moment after
 * every lineup rotation. Replacing a healthy, serving box over it throws away
 * its disk to fix something a request would have fixed.
 *
 * Measured on dev 2026-09-28, the five active boxes on `config_releases`
 * projects reported FOUR different catalog fingerprints — 447ff76ab843,
 * b81ffa236475 (×2), 716c5ec48ba2, and a freshly booted box on 5ac40fb45d61 —
 * all with the same daemon build and all serving. Enforcing an exact match
 * would have replaced three working boxes and kept the one genuinely dead box
 * (no capability, no runtime_truth) for exactly as long as it took to notice.
 */
export function admissionRefusalIsRepairable(check: RuntimeAdmissionCheck): boolean {
  return check === 'catalog_fingerprint';
}

export type RuntimeAdmissionCheck = 'config_release_capability' | 'daemon_build_floor' | 'catalog_fingerprint';

export type RuntimeAdmissionVerdict =
  | { admitted: true }
  | { admitted: false; failedCheck: RuntimeAdmissionCheck; cause: string };

export interface RuntimeAdmissionInput {
  /** The daemon lists `config.release.v1` in its health `capabilities`. */
  hasConfigReleaseCapability: boolean;
  /** `daemon_build` and `catalog_fingerprint`, as the box reports them (Rule 1's actual document). */
  actual: { daemon_build: string | number | null; catalog_fingerprint: string | null };
  /** The platform's current fingerprint — the desired document's opinion, never the box's. */
  desiredCatalogFingerprint: string;
}

function buildMeetsFloor(reported: string | number | null, floor: number): boolean {
  if (reported === null) return false; // cannot prove what it never states
  const numeric = typeof reported === 'number' ? reported : Number(reported);
  return Number.isFinite(numeric) && numeric >= floor;
}

/**
 * Fixed check order — capability, then build floor, then catalog — so a box
 * failing several checks at once is refused for ONE named reason rather than
 * an ambiguous bundle. Every later check is skipped once one refuses: a
 * refused box is refused, and enumerating every other thing ALSO wrong with it
 * tells the operator nothing the first cause didn't already say clearly.
 */
export function evaluateAdmission(
  input: RuntimeAdmissionInput,
  /** The floor to check against. Defaults to the deployment constant; a
   *  caller never overrides this in production — the parameter exists so a
   *  test can assert the compare without depending on process.env at module
   *  load. */
  floor: number = MIN_DAEMON_BUILD,
): RuntimeAdmissionVerdict {
  if (!input.hasConfigReleaseCapability) {
    return {
      admitted: false,
      failedCheck: 'config_release_capability',
      cause: 'the box does not advertise config.release.v1 in its health capabilities',
    };
  }
  if (!buildMeetsFloor(input.actual.daemon_build, floor)) {
    return {
      admitted: false,
      failedCheck: 'daemon_build_floor',
      cause:
        input.actual.daemon_build === null
          ? `the box does not report a daemon_build, so it cannot prove build >= ${floor}`
          : `daemon_build ${input.actual.daemon_build} is below the floor ${floor}`,
    };
  }
  if (input.actual.catalog_fingerprint === null || input.actual.catalog_fingerprint !== input.desiredCatalogFingerprint) {
    return {
      admitted: false,
      failedCheck: 'catalog_fingerprint',
      cause:
        input.actual.catalog_fingerprint === null
          ? 'the box does not report a catalog_fingerprint, so it cannot prove its model lineup is current'
          : `catalog_fingerprint ${input.actual.catalog_fingerprint} does not match the platform's current ${input.desiredCatalogFingerprint}`,
    };
  }
  return { admitted: true };
}
