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
    expect(evaluate(att({ lanes: lanes({ core: 'fail' }) }), 'h').reason).toBe('red');
  });
  it('rejects a missing required lane and any extra lane that is not pass', () => {
    const { core: _core, ...rest } = lanes();
    expect(evaluate(att({ lanes: rest }), 'h').code).toBe(1);
    expect(evaluate(att({ lanes: lanes({ browser: 'skipped-no-db' }) }), 'h').code).toBe(1);
    expect(evaluate(att({ lanes: lanes({ browser: 'pass' }) }), 'h').code).toBe(0);
  });
  it('allows only db-suites to be skipped, and --strict never lets it pass', () => {
    const a = att({ lanes: lanes({ 'db-suites': 'skipped-no-db' }) });
    expect(evaluate(a, 'h').code).toBe(0);
    expect(evaluate(a, 'h', REQUIRED_LANES, true).code).toBe(3);
    expect(evaluate(att({ lanes: lanes({ packages: 'skipped-no-db' }) }), 'h').code).toBe(1);
  });
});
