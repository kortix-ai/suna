import { expect, test } from 'bun:test';

import { getAgentHarnessLabel } from './agent-selector-label';

test('returns the product label for each managed ACP harness', () => {
  expect(getAgentHarnessLabel('opencode')).toBe('OpenCode');
  expect(getAgentHarnessLabel('claude')).toBe('Claude Code');
  expect(getAgentHarnessLabel('codex')).toBe('Codex');
  expect(getAgentHarnessLabel('pi')).toBe('Pi');
});

test('returns null when the project agent has no managed harness', () => {
  expect(getAgentHarnessLabel(null)).toBeNull();
  expect(getAgentHarnessLabel(undefined)).toBeNull();
});
