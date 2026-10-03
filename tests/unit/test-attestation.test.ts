import { describe, expect, it } from 'vitest';
import { REQUIRED_LANES, evaluate } from '../verify-attestation.mjs';

const lanes = (over: Record<string, string> = {}) => ({
  ...Object.fromEntries(REQUIRED_LANES.map((l) => [l, 'pass'])),
  ...over,
});
const att = (over = {}) => ({ source_hash: 'h', passed: true, lanes: lanes(), ...over });

describe('evaluate attestation', () => {
  it('passes a fresh green attestation', () => {
    expect(evaluate(att(), 'h').code).toBe(0);
  });
  it('rejects missing, stale, and red', () => {
    expect(evaluate(null, 'h').code).toBe(1);
    expect(evaluate(att(), 'other').reason).toBe('stale');
    expect(evaluate(att({ passed: false }), 'h').reason).toBe('red');
    expect(evaluate(att({ lanes: lanes({ sdk: 'fail' }) }), 'h').reason).toBe('red');
  });
  it('rejects a missing required lane', () => {
    const { sdk: _sdk, ...rest } = lanes();
    expect(evaluate(att({ lanes: rest }), 'h').code).toBe(1);
  });
  it('never counts a skipped DB lane as a pass', () => {
    const r = evaluate(att({ lanes: lanes({ 'db-suites': 'skipped-no-db' }) }), 'h');
    expect(r.code).toBe(3);
  });
});
