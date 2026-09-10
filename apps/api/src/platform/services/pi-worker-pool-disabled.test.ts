/**
 * The pi warm pool stays OFF by default.
 *
 * It used to be off because a claimed box died on its first resume — the claim
 * env lived only in `park.mjs`'s child process while the container kept
 * `KORTIX_PI_PARK=1`. That is fixed: the claim is persisted and preferred over
 * parking on every later boot (see snapshots/pi-worker-park.test.ts, which
 * drives the real baked script through claim → handoff → restart).
 *
 * The default stays 0 anyway, because enabling a warm pool is a product
 * decision that needs live validation a unit test cannot give: a real provider
 * stop/resume, and the reaper never recycling a box whose claim is on disk.
 * This pins the DEFAULT so turning it on is deliberate.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, 'pi-worker-pool.ts'), 'utf8');
const CONFIG = readFileSync(join(import.meta.dir, '..', '..', 'config.ts'), 'utf8');

describe('the pi worker pool is off by default', () => {
  test('KORTIX_PI_WORKER_POOL_TARGET defaults to 0', () => {
    expect(CONFIG).toContain('KORTIX_PI_WORKER_POOL_TARGET: optInt(0)');
  });

  test('the gate reads that target, so 0 means disabled', () => {
    expect(SRC).toContain('config.KORTIX_PI_WORKER_POOL_TARGET > 0');
  });

  // The comment is the whole point: it is what a person enabling the pool has
  // to walk past — now telling them what to validate rather than what is broken.
  test('the gate says what must be validated before enabling it', () => {
    expect(SRC).toContain('Before enabling it anywhere');
    expect(SRC).toContain('stop/resume');
  });
});
