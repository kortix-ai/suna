import { describe, expect, test } from 'bun:test';

import { policySetNameProblem, supportsPolicySets } from './policy-sets';

describe('supportsPolicySets', () => {
  test('a manifest connector supports sets', () => {
    expect(supportsPolicySets('composio')).toBe(true);
    expect(supportsPolicySets('mcp')).toBe(true);
  });
  test('channel and computer connectors do not', () => {
    expect(supportsPolicySets('channel')).toBe(false);
    expect(supportsPolicySets('Computer')).toBe(false);
  });
});

describe('policySetNameProblem', () => {
  test('a valid new name passes', () => {
    expect(policySetNameProblem('read_only', ['outreach'])).toBeNull();
  });
  test('base is reserved', () => {
    expect(policySetNameProblem('base', [])).toBe('invalid');
  });
  test('upper case, spaces and an empty name are invalid', () => {
    expect(policySetNameProblem('Read only', [])).toBe('invalid');
    expect(policySetNameProblem('', [])).toBe('invalid');
  });
  test('a name the connector already has is taken', () => {
    expect(policySetNameProblem('outreach', ['outreach'])).toBe('taken');
  });
  test('keeping the current name on rename is not a clash', () => {
    expect(policySetNameProblem('outreach', ['outreach'], 'outreach')).toBeNull();
  });
});
