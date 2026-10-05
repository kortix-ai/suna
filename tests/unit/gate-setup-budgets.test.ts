/**
 * THE RULE: two sequential setup phases get two independent budgets.
 *
 * `runner.ts`'s deployed-target setup waits for the current default sandbox
 * image, then for a session on it to reach `ready`. These are sequential and
 * independent: a cold image build can legitimately consume its whole ceiling,
 * and the runtime boot that follows still needs a full budget of its own.
 *
 * They used to share one `setupDeadline = Date.now() + 900_000` while the
 * FIRST wait was itself allowed `timeoutMs: 900_000`. A slow-but-successful
 * image build therefore left the second wait
 * `Math.max(1, setupDeadline - Date.now())` === 1 ms, and it failed instantly
 * on a runtime that was never given a chance to boot.
 *
 * That is how every API shard of the release gate died on v0.13.21, v0.13.22,
 * v0.13.23 and v0.13.24 — `Timed out waiting for sandbox fixture readiness` at
 * 942 s, with no image-readiness error and the "…ready" line never printed.
 * Four releases shipped past a gate that was reporting a product failure that
 * did not exist.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNNER = readFileSync(join(__dirname, '..', 'src', 'core', 'runner.ts'), 'utf8');

/** The `tests-release.yml` API shard cap the two budgets must fit inside. */
const SHARD_CAP_MS = 60 * 60_000;
/** Observed API shard flow time, so setup must leave room for it. */
const OBSERVED_FLOW_TIME_MS = 25 * 60_000;

function budget(name: string): number {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(RUNNER);
  if (!m) throw new Error(`${name} is not declared in runner.ts`);
  return Number(m[1].replaceAll('_', ''));
}

describe('deployed-target setup budgets', () => {
  it('declares a named budget for each phase', () => {
    expect(budget('IMAGE_READY_TIMEOUT_MS')).toBeGreaterThan(0);
    expect(budget('RUNTIME_READY_TIMEOUT_MS')).toBeGreaterThan(0);
  });

  it('never derives the runtime wait from a deadline the image wait can exhaust', () => {
    // The exact shape of the bug. `setupDeadline` may survive in prose, so
    // assert on the executable form: no wait takes a remaining-time timeout.
    expect(RUNNER).not.toMatch(/timeoutMs:\s*Math\.max\(1,\s*setupDeadline/);
    expect(RUNNER).not.toMatch(/timeoutMs:\s*setupDeadline\s*-/);
  });

  it('gives the runtime boot a budget a real cold boot can use', () => {
    // The register records cold provider image builds at 400-540 s and session
    // readiness after that; a boot wait under 5 minutes is the old bug with a
    // bigger number.
    expect(budget('RUNTIME_READY_TIMEOUT_MS')).toBeGreaterThanOrEqual(300_000);
  });

  it('keeps both phases plus the observed flow time inside the shard cap', () => {
    const setup = budget('IMAGE_READY_TIMEOUT_MS') + budget('RUNTIME_READY_TIMEOUT_MS');
    expect(setup + OBSERVED_FLOW_TIME_MS).toBeLessThanOrEqual(SHARD_CAP_MS);
  });

  it('still fails loudly rather than skipping when a phase genuinely times out', () => {
    // Both waits must keep a description, or a gate failure cannot be told
    // apart from the other phase's.
    expect(RUNNER).toContain("description: 'current default sandbox image readiness'");
    expect(RUNNER).toContain("description: 'sandbox fixture readiness'");
  });
});
