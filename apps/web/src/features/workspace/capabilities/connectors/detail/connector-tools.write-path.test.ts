import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connector-tools.tsx'), 'utf8');

/**
 * A source-assertion tripwire, in the shape of
 * `connectors-view.authorization-policy.test.ts`.
 *
 * `orderPolicyRules` is well covered as a pure function, but no behavioural
 * test can see whether the mutation actually calls it. That gap matters more
 * here than usual: the defect it prevents is silent. The runtime takes the
 * FIRST matching rule, so a rule list that reaches the API with a `*` ahead of
 * an exact rule returns 200, persists, and quietly ignores the per-tool
 * decision the user just made. Measured on the live API before the fix:
 *
 *   [{'*': require_approval}, {getpetbyid: always_run}] -> require_approval
 *   [{getpetbyid: always_run}, {'*': require_approval}] -> always_run
 *
 * A second `setConnectorPolicies` call site added later would pass every other
 * test in this suite and reintroduce exactly that. These assertions fail loudly
 * instead.
 */
describe('connector tools write path', () => {
  test('every setConnectorPolicies call orders the rules first', () => {
    const calls = [...source.matchAll(/setConnectorPolicies\(([^)]*)\)/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toContain('orderPolicyRules(');
  });

  test('the optimistic cache is written with the same ordering', () => {
    // Without this the row would show the ordering the server rejected until
    // the refetch landed.
    expect(source).toContain('policies: orderPolicyRules(');
  });

  // The reviewer grepped this by hand. Keeping it as a test means a new
  // caller anywhere under `capabilities/` has to come with its own ordering,
  // rather than inheriting the bug by default.
  test('this file is the only caller in the capabilities tree', () => {
    // `../..` is the capabilities root: this file sits at connectors/detail/.
    const root = join(import.meta.dir, '..', '..');
    const callers = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'))
      .filter((name) => readFileSync(join(root, name), 'utf8').includes('setConnectorPolicies('));
    expect(callers).toEqual(['connectors/detail/connector-tools.tsx']);
  });

  // The reseed guard reads the SAME array the optimistic write reorders, so
  // its signature has to be the order-normalized one. Rebuilding it inline
  // from `advancedRules` would compile, pass every behavioural test, and wipe
  // a half-typed pattern rule on the next per-tool click
  // (`pattern-rule-draft.test.ts` reproduces exactly that).
  test('the reseed guard keys on the order-normalized signature', () => {
    expect(source).toContain('const advancedSignature = useMemo(() => signPatternRules(');
    expect(source).toContain('if (seededSignature.current === advancedSignature) return;');
    expect(source.match(/signPatternRules\(/g)).toHaveLength(2);
  });

  test('rules reach the wire through applyBulkPolicy, never hand-built', () => {
    // Hand-building a rule array would bypass both the case-insensitive
    // replacement and the pattern-preservation guarantee.
    for (const marker of ['applyBulkPolicy(policies, [path], choice)', 'applyBulkPolicy(policies, bulkPaths, bulk.choice)']) {
      expect(source).toContain(marker);
    }
  });
});
