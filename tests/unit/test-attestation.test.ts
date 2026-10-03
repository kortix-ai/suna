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
  it('allows only the sanctioned skips, and --strict never lets them pass', () => {
    const db = att({ lanes: lanes({ 'db-suites': 'skipped-no-db' }) });
    expect(evaluate(db, cur()).code).toBe(0);
    expect(evaluate(db, cur(), REQUIRED_LANES, true).code).toBe(3);
    expect(evaluate(att({ lanes: lanes({ packages: 'skipped-no-db' }) }), cur()).code).toBe(1);
    const sandbox = att({ lanes: lanes({ packages: 'skipped-sandbox-image' }) });
    expect(evaluate(sandbox, cur()).code).toBe(0);
    expect(evaluate(sandbox, cur(), REQUIRED_LANES, true).code).toBe(3);
    expect(evaluate(att({ lanes: lanes({ 'db-suites': 'skipped-sandbox-image' }) }), cur()).code).toBe(1);
    expect(evaluate(att({ lanes: lanes({ packages: 'skipped' }) }), cur()).code).toBe(1);
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
