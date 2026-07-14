import { describe, expect, test } from 'bun:test';

import { shouldGroupAgentsByHarness } from './agent-selector-helpers';

describe('shouldGroupAgentsByHarness', () => {
  test('a single harness renders flat, no group headers', () => {
    expect(shouldGroupAgentsByHarness(['claude'])).toBe(false);
    expect(shouldGroupAgentsByHarness(['claude', 'claude', 'claude'])).toBe(false);
  });

  test('two or more harnesses group', () => {
    expect(shouldGroupAgentsByHarness(['claude', 'codex'])).toBe(true);
    expect(shouldGroupAgentsByHarness(['claude', 'opencode', 'pi'])).toBe(true);
  });

  test('agents with no resolvable harness count as their own bucket', () => {
    expect(shouldGroupAgentsByHarness([null])).toBe(false);
    expect(shouldGroupAgentsByHarness(['claude', null])).toBe(true);
  });

  test('empty list never groups', () => {
    expect(shouldGroupAgentsByHarness([])).toBe(false);
  });
});
