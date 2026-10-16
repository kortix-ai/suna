import { describe, expect, test } from 'bun:test';

import { KORTIX_TOOL_NAMES } from '../constants';

describe('KORTIX_TOOL_NAMES', () => {
  test('no connector tool is a built-in: connectors are the kortix CLI', () => {
    expect(KORTIX_TOOL_NAMES.filter((name) => name.includes('connector'))).toEqual([]);
  });
});

test('a manifest that still lists a retired connector tool gets a warning, not an error', async () => {
  const { validateManifest } = await import('../index');
  const raw = {
    kortix_version: 2,
    default_agent: 'kortix',
    agents: { kortix: { file: 'agents/kortix.md' } },
    tools: { web_search: 'kortix:web_search', 'kortix-connectors_call': 'kortix:kortix-connectors_call' },
  };
  const issues = validateManifest(raw as never, 'yaml').issues.filter((issue) => issue.path === 'tools.kortix-connectors_call');
  expect(issues.map((issue) => issue.severity)).toEqual(['warning']);
});
