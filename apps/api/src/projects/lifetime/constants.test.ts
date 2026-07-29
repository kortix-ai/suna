/**
 * BOUNDED SANDBOX LIFETIME — LAYER 4 OF THE STRUCTURAL GUARD: anti-widening.
 *
 * The 2026-06-24 regression that cost 78% of a week's billed sandbox-hours was
 * a one-line env-knob widening, buried as item 3 of an unrelated commit, with
 * zero tests. Every assertion here exists so that the same edit fails loudly.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ABSOLUTE_RUN_CAP_MS,
  BOOT_GRACE_MS,
  COMPUTE_LIVENESS_GRACE_MS,
  IDLE_GRACE_MS,
  LIFETIME_CONSTANT_ORDER,
  POST_TURN_GRACE_MS,
  PROGRESS_GRANT_MS,
  PROVIDER_NATIVE_AUTOSTOP_MS,
  TRIGGER_POST_TURN_GRACE_MS,
  TURN_CEILING_MS,
  WARM_POOL_TTL_MS,
} from './constants';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..');

test('the lifetime constants are exactly these values', () => {
  // Not a range, not a relation — the literals. Changing the maximum life of
  // every sandbox on the platform should require editing a test that says so.
  expect({
    TRIGGER_POST_TURN_GRACE_MS,
    IDLE_GRACE_MS,
    BOOT_GRACE_MS,
    POST_TURN_GRACE_MS,
    WARM_POOL_TTL_MS,
    COMPUTE_LIVENESS_GRACE_MS,
    PROGRESS_GRANT_MS,
    TURN_CEILING_MS,
    ABSOLUTE_RUN_CAP_MS,
    PROVIDER_NATIVE_AUTOSTOP_MS,
  }).toEqual({
    TRIGGER_POST_TURN_GRACE_MS: 300_000,
    IDLE_GRACE_MS: 900_000,
    BOOT_GRACE_MS: 1_200_000,
    POST_TURN_GRACE_MS: 1_800_000,
    WARM_POOL_TTL_MS: 2_700_000,
    COMPUTE_LIVENESS_GRACE_MS: 3_600_000,
    PROGRESS_GRANT_MS: 7_200_000,
    TURN_CEILING_MS: 14_400_000,
    ABSOLUTE_RUN_CAP_MS: 86_400_000,
    PROVIDER_NATIVE_AUTOSTOP_MS: 90_000_000,
  });
});

test('the required ordering relation holds', () => {
  // Reduced to a single comparison of the whole chain so a failure NAMES the
  // pair that broke rather than reporting "expected 900000 to be <= 300000".
  const names = LIFETIME_CONSTANT_ORDER.map(([name]) => name);
  const sorted = [...LIFETIME_CONSTANT_ORDER].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  expect(names).toEqual(sorted);
  // The provider's own timer must be LARGER than our cap, or it races us and
  // kills boxes mid-tool-run — the 2026-06-24 failure mode exactly.
  expect(PROVIDER_NATIVE_AUTOSTOP_MS).toBeGreaterThan(ABSOLUTE_RUN_CAP_MS);
});

test('BOOT_GRACE_MS clears the runtime-readiness wait plus two maintenance ticks', () => {
  // The row flips to `active` at provider-create, not at usability, and
  // continueSession then waits up to READY_DEADLINE_MS for the runtime before
  // it may deliver a prompt. A boot grace at or below that wait, with the sweep
  // interval as tiebreaker, silently kills cold-boot trigger sessions.
  const engine = readFileSync(
    resolve(import.meta.dir, '..', 'session-lifecycle', 'engine.ts'),
    'utf8',
  );
  const readyDeadline = engine.match(/READY_DEADLINE_MS\s*=\s*([0-9_]+)/);
  if (!readyDeadline?.[1]) throw new Error('READY_DEADLINE_MS not found in engine.ts');
  const readyDeadlineMs = Number(readyDeadline[1].replaceAll('_', ''));
  expect(readyDeadlineMs).toBeGreaterThan(0);
  const maintenanceTickMs = 5 * 60_000;
  expect(BOOT_GRACE_MS).toBeGreaterThan(readyDeadlineMs + 2 * maintenanceTickMs - 1);
});

test('no lifetime constant is env-overridable', () => {
  // Comments stripped first: the file's own docstring explains WHY it must not
  // read process.env, and a naive substring match would fail on that sentence
  // and get "fixed" by deleting the explanation.
  const code = readFileSync(resolve(import.meta.dir, 'constants.ts'), 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');
  expect(code).not.toContain('process.env');
  expect(code).not.toContain('Bun.env');
});

test('ABSOLUTE_RUN_CAP_MS matches the DB CHECK literal', () => {
  // The duplication is deliberate: the schema must bound the value even when
  // every line of this application is wrong. This is what keeps the two copies
  // honest — an engineer who widens one and not the other fails here.
  const migration = readFileSync(
    resolve(REPO_ROOT, 'packages/db/migrations/20260730090000003_sandbox_deadline_check.sql'),
    'utf8',
  );
  expect(migration).toContain(`interval '${ABSOLUTE_RUN_CAP_MS / 3_600_000} hours'`);
});

test('the anchor guard trigger floors at BOOT_GRACE_MS', () => {
  const migration = readFileSync(
    resolve(REPO_ROOT, 'packages/db/migrations/20260730090000005_sandbox_anchor_guard.sql'),
    'utf8',
  );
  expect(migration).toContain(`interval '${BOOT_GRACE_MS / 60_000} minutes'`);
});

test('the usage progress trigger grants PROGRESS_GRANT_MS', () => {
  const migration = readFileSync(
    resolve(
      REPO_ROOT,
      'packages/db/migrations/20260730090000006_usage_extends_sandbox_deadline.sql',
    ),
    'utf8',
  );
  expect(migration).toContain(`interval '${PROGRESS_GRANT_MS / 3_600_000} hours'`);
  expect(migration).toContain(`interval '${ABSOLUTE_RUN_CAP_MS / 3_600_000} hours'`);
});

describe('the compute meter and the compute lifetime', () => {
  test('agree on the maximum window, and the agreement is not accidental', () => {
    // The original design claimed these "agree by construction". They do not:
    // computeMaxWindowMs() is positiveEnvInt('KORTIX_COMPUTE_MAX_WINDOW_HOURS',
    // 24) — env-overridable. They agree today by coincidence of two
    // independently-settable defaults, which is the 2026-06-24 shape exactly.
    // Pin the default here; the boot-time assertion covers the override.
    const source = readFileSync(resolve(import.meta.dir, '..', 'reaper-constants.ts'), 'utf8');
    const match = source.match(/KORTIX_COMPUTE_MAX_WINDOW_HOURS'?,\s*([0-9]+)/);
    if (!match?.[1]) throw new Error('computeMaxWindowMs default not found');
    expect(Number(match[1]) * 3_600_000).toBe(ABSOLUTE_RUN_CAP_MS);
  });
});
