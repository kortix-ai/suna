import { describe, expect, test } from 'bun:test';

import { KORTIX_TOOL_NAMES } from '../constants';
import { validateManifest } from '../index';

describe('KORTIX_TOOL_NAMES', () => {
  test('no connector tool is a built-in: connectors are the kortix CLI', () => {
    expect(KORTIX_TOOL_NAMES.filter((name) => name.includes('connector'))).toEqual([]);
  });
});

// An exclude or a grant of a tool that no longer exists must not stop every session.
test('an agent that still names a retired connector tool gets a warning, not an error', () => {
  const retired = ['kortix-connectors_call', 'kortix-connectors_describe'];
  for (const tools of [{ exclude: retired }, ['web_search', ...retired]]) {
    const raw = { default_agent: 'kortix', agents: { kortix: { mode: 'primary', tools } } };
    const result = validateManifest(raw);
    const issues = result.issues.filter((issue) => issue.path === 'agents.kortix.tools');
    expect({ tools, valid: result.valid, severities: issues.map((issue) => issue.severity) }).toEqual({ tools, valid: true, severities: ['warning'] });
  }
});

test('an agent that names an unknown tool is still an error', () => {
  const raw = { default_agent: 'kortix', agents: { kortix: { mode: 'primary', tools: { exclude: ['kortix-connectors_other'] } } } };
  expect(validateManifest(raw).valid).toBe(false);
});
