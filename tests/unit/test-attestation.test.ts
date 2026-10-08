import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REQUIRED_LANES, evaluate } from '../verify-attestation.mjs';

const diffHash = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');

const lanes = (over: Record<string, string> = {}) => ({
  ...Object.fromEntries(REQUIRED_LANES.map((l) => [l, 'pass'])),
  ...over,
});
const att = (over = {}) => ({ source_hash: 'h', passed: true, lanes: lanes(), ...over });
// No diff fields on `att`, so freshness falls back to the full-tree source_hash.
const cur = (sourceHash = 'h') => ({ sourceHash, changed: null });

describe('evaluate attestation', () => {
  it('passes a fresh green attestation', () => {
    expect(evaluate(att(), cur()).code).toBe(0);
  });
  it('rejects missing, stale, and red', () => {
    expect(evaluate(null, cur()).code).toBe(1);
    expect(evaluate(att(), cur('other')).reason).toBe('stale');
    expect(evaluate(att({ passed: false }), cur()).reason).toBe('red');
    expect(evaluate(att({ lanes: lanes({ core: 'fail' }) }), cur()).reason).toBe('red');
  });
  it('rejects a missing required lane and any extra lane that is not pass', () => {
    const { core: _core, ...rest } = lanes();
    expect(evaluate(att({ lanes: rest }), cur()).code).toBe(1);
    expect(evaluate(att({ lanes: lanes({ browser: 'skipped-no-db' }) }), cur()).code).toBe(1);
    expect(evaluate(att({ lanes: lanes({ browser: 'pass' }) }), cur()).code).toBe(0);
  });
  it('allows only db-suites to be skipped, and --strict never lets it pass', () => {
    const a = att({ lanes: lanes({ 'db-suites': 'skipped-no-db' }) });
    expect(evaluate(a, cur()).code).toBe(0);
    expect(evaluate(a, cur(), REQUIRED_LANES, true).code).toBe(3);
    expect(evaluate(att({ lanes: lanes({ packages: 'skipped-no-db' }) }), cur()).code).toBe(1);
  });
  it('a diff that touches packages/db needs db-suites=pass, not skipped-no-db', () => {
    const skipped = att({ lanes: lanes({ 'db-suites': 'skipped-no-db' }) });
    const touching = { sourceHash: 'h', changed: { files: ['packages/db/migrations/x.sql'], lines: {}, hash: '', attestations: [] } };
    const other = { sourceHash: 'h', changed: { files: ['apps/web/a.ts'], lines: {}, hash: '', attestations: [] } };
    expect(evaluate(skipped, touching).code).toBe(1);
    expect(evaluate(skipped, touching).reason).toContain('packages/db');
    expect(evaluate(att(), touching).code).toBe(0);
    expect(evaluate(skipped, other).code).toBe(0);
  });
  it('no skip exists for packages: any skipped-sandbox-image lane value is not green', () => {
    const a = att({ lanes: lanes({ packages: 'skipped-sandbox-image', 'db-suites': 'skipped-no-db' }) });
    expect(evaluate(a, cur()).code).toBe(1);
    expect(evaluate(a, cur()).reason).toContain('packages');
    expect(evaluate(att({ lanes: lanes({ core: 'skipped-sandbox-image' }) }), cur()).code).toBe(1);
    expect(evaluate(att({ lanes: lanes({ 'db-suites': 'skipped-sandbox-image' }) }), cur()).code).toBe(1);
  });
  it('a diff-keyed attestation ignores source_hash: fresh iff its own files are unchanged', () => {
    const line = '100644 blob1 pr.txt';
    const a = att({ diff_files: ['pr.txt'], diff_hash: diffHash([line]) });
    // source_hash differs (an unrelated main-merge), but the PR's file is unchanged → green.
    const unchanged = { sourceHash: 'other', changed: { lines: { 'pr.txt': line } } };
    expect(evaluate(a, unchanged).code).toBe(0);
    // the PR's own file changed → stale.
    const edited = { sourceHash: 'h', changed: { lines: { 'pr.txt': '100644 blob2 pr.txt' } } };
    expect(evaluate(a, edited).reason).toBe('stale');
    // the file dropped out of the changed set → stale.
    const dropped = { sourceHash: 'h', changed: { lines: {} } };
    expect(evaluate(a, dropped).reason).toBe('stale');
  });
});
