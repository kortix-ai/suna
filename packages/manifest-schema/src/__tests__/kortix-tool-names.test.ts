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

// A v2 → v3 upgrade wrote these excludes while #9902 was live. An exclude or a
// grant of a tool that no longer exists must not stop every session.
test('a v3 agent that still names a retired connector tool gets a warning, not an error', async () => {
  const { validateManifest } = await import('../index');
  const retired = ['kortix-connectors_call', 'kortix-connectors_describe'];
  for (const tools of [{ exclude: retired }, ['web_search', ...retired]]) {
    const raw = { kortix_version: 3, default_agent: 'kortix', agents: { kortix: { mode: 'primary', tools } } };
    const result = validateManifest(raw as never, 'yaml');
    const issues = result.issues.filter((issue) => issue.path === 'agents.kortix.tools');
    expect({ tools, valid: result.valid, severities: issues.map((issue) => issue.severity) }).toEqual({ tools, valid: true, severities: ['warning'] });
  }
});

test('a v3 agent that names an unknown tool is still an error', async () => {
  const { validateManifest } = await import('../index');
  const raw = { kortix_version: 3, default_agent: 'kortix', agents: { kortix: { mode: 'primary', tools: { exclude: ['kortix-connectors_other'] } } } };
  expect(validateManifest(raw as never, 'yaml').valid).toBe(false);
});

// kortixd hosts `remember` and `memory_search` in every channel or DM thread:
// a project tool of that name would shadow the platform tool.
test('a project tool with a platform tool name is an error; an agent may exclude one by name', async () => {
  const { validateManifest, PLATFORM_TOOL_NAMES } = await import('../index');
  expect([...PLATFORM_TOOL_NAMES]).toEqual(['remember', 'memory_search']);
  for (const name of PLATFORM_TOOL_NAMES) {
    const v2 = { kortix_version: 2, default_agent: 'kortix', agents: { kortix: { file: 'agents/kortix.md' } }, tools: { [name]: `tools/${name}.ts` } };
    const v3 = { kortix_version: 3, default_agent: 'kortix', agents: { kortix: { mode: 'primary' } }, tools: { [name]: `tools/${name}.ts` } };
    for (const raw of [v2, v3]) {
      const issues = validateManifest(raw as never, 'yaml').issues.filter((issue) => issue.path === `tools.${name}`);
      expect(issues.map((issue) => [issue.severity, issue.message])).toEqual([['error', `"${name}" is a built-in tool; pick another name.`]]);
    }
  }
  const exclude = { kortix_version: 3, default_agent: 'kortix', agents: { kortix: { mode: 'primary', tools: { exclude: ['remember'] } } } };
  expect(validateManifest(exclude as never, 'yaml').issues.filter((issue) => issue.path === 'agents.kortix.tools')).toEqual([]);
});
