/**
 * The two constants that were one number until 2026-07-30, and the ordering
 * relation between them.
 *
 *   providerAutoStopBackstopMinutes()  — platform/providers/index.ts
 *   billingLivenessGraceMinutes()      — billing/services/compute-liveness.ts
 *
 * `computeLivenessGraceMs()` used to BE `providerAutoStopBackstopMinutes()`, so
 * the money clamp could not be kept tight without also keeping the provider's
 * idle timer tight enough to kill boxes mid long-tool-run — and the provider
 * timer could not be raised without silently extending how long a provably-dead
 * box may bill. This file is the guard that they stay separate AND correctly
 * ordered: a future edit that re-welds them, or that inverts the ordering, fails
 * here.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The real config process.exits on an incomplete local env. Mutable so a test
// can sweep either knob and watch what does — and does not — move.
const cfg: {
  KORTIX_SANDBOX_AUTOSTOP_MINUTES?: number;
  KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES?: number;
} = {};
mock.module('../../config', () => ({ config: cfg, SANDBOX_VERSION: 'test-version' }));
mock.module('../../shared/db', () => ({ db: {} }));

const { providerAutoStopBackstopMinutes } = await import('./index');
const { billingLivenessGraceMinutes } = await import('../../billing/services/compute-liveness');

/** kortix-prod-env, confirmed 2026-07-29. */
const PROD_IDLE_WINDOW_MINUTES = 15;

beforeEach(() => {
  cfg.KORTIX_SANDBOX_AUTOSTOP_MINUTES = PROD_IDLE_WINDOW_MINUTES;
  cfg.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES = undefined;
});

describe('providerAutoStopBackstopMinutes — the provider-safety knob', () => {
  // The in-box keep-alive that used to reset this timer (a fetch of
  // ${providerUrl}/kortix/health from the execution-lease reporter) is deleted,
  // so during a turn spent in local tools NOTHING resets it. Measured on 30
  // days of prod: p99 turn ~78 min, MAX ~8.4h, p99.9 gap between consecutive
  // usage_events ~1h. 12h is ~1.4x the worst turn ever observed.
  test('defaults to 12h — above the longest turn ever measured (~8.4h)', () => {
    expect(providerAutoStopBackstopMinutes()).toBe(720);
    expect(providerAutoStopBackstopMinutes()).toBeGreaterThan(8.4 * 60);
  });

  test('is separately tunable', () => {
    cfg.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES = 300;
    expect(providerAutoStopBackstopMinutes()).toBe(300);
  });

  // Floored at the value it returned before the split, so a mis-set env var
  // cannot resurrect the 2026-06-24 "stopped too quickly mid-session" class.
  // Callers wanting a deliberately short timer pass an explicit override.
  test('floors at 60 minutes, whatever the env says', () => {
    for (const bad of [-1, 1, 5, 59]) {
      cfg.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES = bad;
      expect(providerAutoStopBackstopMinutes()).toBe(60);
    }
  });

  // 0 is Daytona's and Platinum's encoding for "persistent — never auto-stop".
  // It must NEVER reach them from here: an unbounded box is the whole defect.
  test('reads 0 as unset, never as "never auto-stop"', () => {
    cfg.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES = 0;
    expect(providerAutoStopBackstopMinutes()).toBe(720);
  });

  // THE DECOUPLING, direction 1. Before the split this read
  // KORTIX_SANDBOX_AUTOSTOP_MINUTES and returned max(60, idle * 2), so widening
  // the idle window silently moved the provider's timer.
  test('REGRESSION: does not move when the idle window moves', () => {
    for (const idle of [1, 5, 15, 45, 120, 600]) {
      cfg.KORTIX_SANDBOX_AUTOSTOP_MINUTES = idle;
      expect(providerAutoStopBackstopMinutes()).toBe(720);
    }
  });
});

describe('the ordering relation the two constants must satisfy', () => {
  // A window may never bill past the point the provider guarantees the box is
  // gone. Equality was the old state; strict inequality is the point of the
  // split — the provider timer has to be loose enough not to kill work, the
  // billing grace tight enough not to pay for corpses.
  test('the billing grace sits strictly inside the provider backstop', () => {
    expect(billingLivenessGraceMinutes()).toBeLessThan(providerAutoStopBackstopMinutes());
    expect(billingLivenessGraceMinutes()).toBe(60);
    expect(providerAutoStopBackstopMinutes()).toBe(720);
  });

  // Why the relation is structural and not just true at the defaults: BOTH
  // constants floor at 60, and the billing grace only leaves its floor once the
  // idle window passes 30 minutes — which no environment sets (prod 15, dev 15,
  // trigger 5). So across the entire configured space the relation is 60 <= 60.
  test('holds for every configured pairing of the two knobs', () => {
    for (const idle of [undefined, 1, 5, 15, 30]) {
      for (const backstop of [undefined, 0, 60, 120, 300, 720, 1440]) {
        cfg.KORTIX_SANDBOX_AUTOSTOP_MINUTES = idle;
        cfg.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES = backstop;
        expect(billingLivenessGraceMinutes()).toBeLessThanOrEqual(
          providerAutoStopBackstopMinutes(),
        );
      }
    }
  });

  // And across the whole plausible idle range at the shipped backstop default,
  // which is the pairing an edit to either default would break.
  test('holds for every plausible idle window at the default backstop', () => {
    for (const idle of [1, 5, 15, 30, 60, 120, 240, 359]) {
      cfg.KORTIX_SANDBOX_AUTOSTOP_MINUTES = idle;
      expect(billingLivenessGraceMinutes()).toBeLessThanOrEqual(providerAutoStopBackstopMinutes());
    }
  });

  // The lower bound on the same number: maintenance runs every 5 minutes
  // (projects/maintenance.ts DEFAULT_MAINTENANCE_INTERVAL_MS), and a grace
  // shorter than two passes lets one missed pass zero a HEALTHY box's revenue.
  test('the billing grace still covers at least two maintenance passes', () => {
    const maintenanceIntervalMinutes = 5;
    expect(billingLivenessGraceMinutes()).toBeGreaterThanOrEqual(2 * maintenanceIntervalMinutes);
  });
});
