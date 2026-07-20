import { describe, expect, test } from 'bun:test';

import { HARNESS_IDS } from '@kortix/shared/harnesses';

import {
  AGENT_GROUP_ORDER,
  isHarnessDisconnected,
  shouldGroupAgentsByHarness,
} from './agent-selector-helpers';

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

describe('AGENT_GROUP_ORDER', () => {
  test('is every canonical harness in HARNESS_IDS order, followed by "other"', () => {
    expect(AGENT_GROUP_ORDER).toEqual([...HARNESS_IDS, 'other']);
  });
});

describe('isHarnessDisconnected', () => {
  test('a ready runtime is connected — no dot', () => {
    expect(isHarnessDisconnected('ready')).toBe(false);
  });

  test('a checking runtime is still resolving — no dot yet', () => {
    expect(isHarnessDisconnected('checking')).toBe(false);
  });

  test('missing, ambiguous, needs-attention, and unavailable all count as not connected', () => {
    expect(isHarnessDisconnected('missing')).toBe(true);
    expect(isHarnessDisconnected('ambiguous')).toBe(true);
    expect(isHarnessDisconnected('needs-attention')).toBe(true);
    expect(isHarnessDisconnected('unavailable')).toBe(true);
  });

  test('no runtime entry for the harness (status unknown) never shows a dot', () => {
    expect(isHarnessDisconnected(undefined)).toBe(false);
  });
});
