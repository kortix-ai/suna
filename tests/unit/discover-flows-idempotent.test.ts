import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression for the first sharded release-gate run (32222342409): `--shard`
 * calls discoverFlows() to plan its ids, then runSuite() calls it again. The
 * second call used to clearRegistry() and re-import the (cached) flow modules,
 * which never re-execute — so the registry came back EMPTY and every API shard
 * died with "no flows matched the selected filters". Run in a subprocess so
 * this test owns a pristine module graph.
 */
function countAfterDoubleDiscover(): { first: number; second: number } {
  const testsDir = resolve(import.meta.dirname, '..');
  const script = `
    const { discoverFlows } = await import(${JSON.stringify(`${testsDir}/src/core/runner.ts`)});
    const { allFlows } = await import(${JSON.stringify(`${testsDir}/src/core/flow.ts`)});
    await discoverFlows();
    const first = allFlows().length;
    await discoverFlows();
    const second = allFlows().length;
    console.log(JSON.stringify({ first, second }));
  `;
  const out = execFileSync('bun', ['-e', script], { cwd: testsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!);
}

describe('discoverFlows is idempotent within one process', () => {
  it('a second discoverFlows() keeps every registered flow', () => {
    const { first, second } = countAfterDoubleDiscover();
    expect(first).toBeGreaterThan(400);
    expect(second).toBe(first);
  });
});
