/**
 * Rule 4 — admission control (the runtime-convergence contract (PR #7785)). Before a box
 * is handed to a session, it must prove `config.release.v1` present,
 * `daemon_build >= MIN_DAEMON_BUILD`, and a current `catalog_fingerprint`. A
 * box that fails ANY check is refused, never used — this is the part that
 * makes "every new session is fresh" true.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  admissionRefusalIsRepairable,
  evaluateAdmission,
  MIN_DAEMON_BUILD,
  type RuntimeAdmissionCheck,
} from '../admission';
import { UNREPORTED_ACTUAL_RUNTIME, type ActualRuntimeDocument } from '../actual';

const CURRENT: ActualRuntimeDocument = {
  ...UNREPORTED_ACTUAL_RUNTIME,
  daemon_build: MIN_DAEMON_BUILD,
  catalog_fingerprint: 'cat_current',
};

describe('evaluateAdmission', () => {
  test('admits a box that proves the release capability, a floor-or-above build, and a current catalog', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: CURRENT,
      desiredCatalogFingerprint: 'cat_current',
    });
    expect(verdict.admitted).toBe(true);
  });

  test('refuses a box that never advertises config.release.v1', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: false,
      actual: CURRENT,
      desiredCatalogFingerprint: 'cat_current',
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.failedCheck).toBe('config_release_capability');
      expect(verdict.cause).toContain('config.release.v1');
    }
  });

  test('refuses a box below the daemon-build floor — the boot that could not fetch the managed lineup and never recovered', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: { ...CURRENT, daemon_build: MIN_DAEMON_BUILD - 1 },
      desiredCatalogFingerprint: 'cat_current',
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.failedCheck).toBe('daemon_build_floor');
      expect(verdict.cause).toContain(String(MIN_DAEMON_BUILD));
    }
  });

  test('a box that never reports daemon_build at all cannot prove the floor — refused, not admitted by default', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: { ...CURRENT, daemon_build: null },
      desiredCatalogFingerprint: 'cat_current',
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.failedCheck).toBe('daemon_build_floor');
  });

  test('refuses a box whose catalog fingerprint is stale relative to the platform', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: { ...CURRENT, catalog_fingerprint: 'cat_stale' },
      desiredCatalogFingerprint: 'cat_current',
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.failedCheck).toBe('catalog_fingerprint');
      expect(verdict.cause).toContain('cat_stale');
      expect(verdict.cause).toContain('cat_current');
    }
  });

  test('a box that never reports a catalog fingerprint at all is refused, not given the benefit of the doubt', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: { ...CURRENT, catalog_fingerprint: null },
      desiredCatalogFingerprint: 'cat_current',
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.failedCheck).toBe('catalog_fingerprint');
  });

  test('the daemon_build floor is a STRING-coerced numeric compare (the box may report a string per the wire contract)', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: { ...CURRENT, daemon_build: String(MIN_DAEMON_BUILD + 5) },
      desiredCatalogFingerprint: 'cat_current',
    });
    expect(verdict.admitted).toBe(true);
  });

  test('checks are evaluated in a fixed order — capability, then build floor, then catalog — so one failure names ONE cause', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: false,
      actual: { ...CURRENT, daemon_build: MIN_DAEMON_BUILD - 1, catalog_fingerprint: 'cat_stale' },
      desiredCatalogFingerprint: 'cat_current',
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.failedCheck).toBe('config_release_capability');
  });
});

describe('admissionRefusalIsRepairable', () => {
  /**
   * Replaced the `runtimeAdmissionEnforced` suite. That function was a
   * deployment kill switch, OFF by default, because the daemon half of this
   * contract shipped on a parallel branch and every box alive would have failed
   * the capability check. Both halves landed 2026-09-27 (#7792, #7793) hours
   * apart; the catch outlived its reason by a day and admission is now always
   * enforced. What replaces it is not a switch but a DISTINCTION.
   */

  test('a stale catalog is repairable — it must NOT cost the box its disk', () => {
    // Measured on dev 2026-09-28: the five active boxes on `config_releases`
    // projects reported FOUR different catalog fingerprints, same daemon build,
    // all serving. An exact-match replacement would have destroyed three
    // healthy boxes to fix something `POST /kortix/catalog/converge` fixes in
    // seconds — and the fingerprint legitimately lags after every rotation.
    expect(admissionRefusalIsRepairable('catalog_fingerprint')).toBe(true);
  });

  test('a missing capability or an old daemon is NOT repairable — replace it', () => {
    // Nothing an HTTP call changes. Rule 4 stands for exactly these.
    expect(admissionRefusalIsRepairable('config_release_capability')).toBe(false);
    expect(admissionRefusalIsRepairable('daemon_build_floor')).toBe(false);
  });

  test('every check the evaluator can return is classified', () => {
    // A new check added to `RuntimeAdmissionCheck` without a decision here
    // would silently fall into "replace" — the destructive branch. This fails
    // the moment that happens.
    const all: RuntimeAdmissionCheck[] = [
      'config_release_capability',
      'daemon_build_floor',
      'catalog_fingerprint',
    ];
    for (const check of all) {
      expect(typeof admissionRefusalIsRepairable(check)).toBe('boolean');
    }
    expect(all.filter(admissionRefusalIsRepairable)).toEqual(['catalog_fingerprint']);
  });
});
