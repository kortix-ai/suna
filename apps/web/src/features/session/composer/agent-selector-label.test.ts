import { expect, test } from 'bun:test';

import { getAgentHarnessFaviconDomain, getAgentHarnessLabel } from './agent-selector-label';

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

test('returns one distinct official favicon domain for each managed ACP harness', () => {
  const domains = [
    getAgentHarnessFaviconDomain('opencode'),
    getAgentHarnessFaviconDomain('claude'),
    getAgentHarnessFaviconDomain('codex'),
    getAgentHarnessFaviconDomain('pi'),
  ];

  expect(domains).toEqual(['opencode.ai', 'claude.ai', 'openai.com', 'pi.dev']);
  expect(new Set(domains).size).toBe(4);
});

test('returns null favicon metadata when the project agent has no managed harness', () => {
  expect(getAgentHarnessFaviconDomain(null)).toBeNull();
  expect(getAgentHarnessFaviconDomain(undefined)).toBeNull();
});
