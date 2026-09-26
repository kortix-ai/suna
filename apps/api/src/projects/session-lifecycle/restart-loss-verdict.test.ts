/**
 * Incident 2026-08-14
 * (docs/incidents/2026-08-14-computer-lost-false-alarm-and-boot-failures.md).
 *
 * Corrective action 1: "Show the 'computer was lost' copy only when a fresh
 * `provider.getStatus()` returns `removed` at preserve time."
 *
 * `runtime-identity.ts` states the same rule as an invariant of the module:
 * only a definitive provider `removed` may classify an identity as lost;
 * everything else parks a retriable row. `runtimeLossVerdict` is the gate that
 * enforces it, and `runtime-identity.test.ts` pins the gate itself.
 *
 * A gate is only worth what its call sites are, and `restart-in-place` has
 * three preserve sites that no unit test can reach: they live inside a
 * detached async continuation behind a provider client. Two were already
 * gated on `getStatus() === 'removed'`; the third — the one in the catch
 * block — reached `preserveEstablishedRuntime` on an error-message heuristic
 * alone. These are source assertions because that is what is testable here,
 * and the alternative is no coverage at all on the exact line the incident
 * was written about.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const actions = readFileSync(join(import.meta.dir, 'actions.ts'), 'utf8');

/** The catch-block branch: from the heuristic to the end of its `return`. */
function missingRuntimeBranch(): string {
  const start = actions.indexOf('if (isMissingRuntimeError(err)) {');
  expect(start).toBeGreaterThan(-1);
  return actions.slice(start, actions.indexOf('const [failedRestart]', start));
}

describe('restart-in-place never declares a loss the provider did not confirm', () => {
  test('every preserve in this file is preceded by a definitive removed check', () => {
    // Three call sites, and the count is asserted so a fourth added later has
    // to come here and account for itself rather than inheriting silence.
    const preserves = actions.match(/await preserveEstablishedRuntime\(/g) ?? [];
    expect(preserves.length).toBe(3);

    let searchFrom = 0;
    for (let i = 0; i < preserves.length; i++) {
      const at = actions.indexOf('await preserveEstablishedRuntime(', searchFrom);
      expect(at).toBeGreaterThan(-1);
      const preceding = actions.slice(Math.max(0, at - 1600), at);
      // Either an explicit `=== 'removed'` guard (the two sibling paths) or
      // the shared gate (the catch-block path).
      const gated =
        /(providerStatus|verifiedStatus|status) === 'removed'/.test(preceding) ||
        /runtimeLossVerdict\([^)]*\) === 'preserve'/.test(preceding);
      expect(gated).toBe(true);
      searchFrom = at + 1;
    }
  });

  test('the catch-block branch asks the provider before it decides', () => {
    const branch = missingRuntimeBranch();
    // The heuristic that got us into this branch is not evidence: it matches
    // any error whose message merely contains "not found".
    expect(branch).toContain('provider.getStatus(externalId)');
    expect(branch).toContain("runtimeLossVerdict(status) === 'preserve'");
  });

  test('anything short of removed parks — retriable, and the box is stopped', () => {
    const branch = missingRuntimeBranch();
    // parkEstablishedRuntime is the only one of the two that calls
    // provider.stop(); preserving here left the box running (incident root
    // cause 3, the compute leak).
    expect(branch).toContain('await parkEstablishedRuntime(');

    // The park must be the ELSE of the verdict, never the other way round.
    const verdictAt = branch.indexOf("runtimeLossVerdict(status) === 'preserve'");
    const preserveAt = branch.indexOf('await preserveEstablishedRuntime(');
    const parkAt = branch.indexOf('await parkEstablishedRuntime(');
    expect(verdictAt).toBeGreaterThan(-1);
    expect(preserveAt).toBeGreaterThan(verdictAt);
    expect(parkAt).toBeGreaterThan(preserveAt);
  });

  test('a provider that cannot answer parks rather than throwing out of the continuation', () => {
    // This runs detached from the request, after the 202. An unhandled throw
    // here is an unhandled rejection, not a 500 the caller could see.
    const branch = missingRuntimeBranch();
    expect(branch).toContain("return 'unknown' as const;");
    // 'unknown' is a probe failure, not evidence — the gate parks on it.
    expect(branch).toContain('} catch {');
  });
});
