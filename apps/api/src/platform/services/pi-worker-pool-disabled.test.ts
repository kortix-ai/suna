/**
 * The pi warm pool stays OFF until its resume defect is fixed.
 *
 * A claim hands the session's env to `park.mjs` over HTTP, which execs the
 * worker with it — but only in that child process. The container keeps
 * `KORTIX_PI_PARK=1`, so the first stop/resume re-execs the entrypoint into
 * park mode with the claim env gone: port 8000 answers
 * `{parked:true,runtimeReady:false}` forever and the session can never run
 * another turn. A cold-created box resumes fine, so the failure hits only the
 * fast path and reads as random.
 *
 * This is not a test of the pool. It pins the DEFAULT, so switching it on is a
 * deliberate act by someone who had to change a test and therefore had to read
 * why.
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
  // to walk past.
  test('the gate carries the known-defect warning', () => {
    expect(SRC).toContain('KNOWN DEFECT');
    expect(SRC).toContain('KORTIX_PI_PARK');
  });
});
