import { describe, expect, test } from 'bun:test';

import { KORTIX_TOOL_NAMES, RETIRED_KORTIX_TOOLS, selectedKortixTools } from '../constants';
import { fixManifestText } from '../deprecations';
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

// `memory` was a Kortix tool until 2026-10-30. A manifest that still names it keeps working.
describe('the retired `memory` tool', () => {
  test('is no Kortix tool and no default', () => {
    expect(KORTIX_TOOL_NAMES as readonly string[]).not.toContain('memory');
    expect(selectedKortixTools(undefined)).not.toContain('memory');
    expect(RETIRED_KORTIX_TOOLS).toContain('memory');
  });

  test('an agent that grants or excludes it gets a warning that names what replaces it, not an error', () => {
    for (const tools of [{ exclude: ['memory'] }, ['read', 'write', 'memory']]) {
      const raw = { default_agent: 'kortix', agents: { kortix: { mode: 'primary', tools } } };
      const result = validateManifest(raw);
      const issues = result.issues.filter((issue) => issue.path === 'agents.kortix.tools');
      expect({ tools, valid: result.valid, severities: issues.map((issue) => issue.severity) }).toEqual({ tools, valid: true, severities: ['warning'] });
      expect(issues[0]!.message).toContain('a retired Kortix tool name does nothing');
      expect(issues[0]!.message).toContain('`kortix_memory`');
      expect(issues[0]).toMatchObject({ fix: 'tool-retired' });
    }
  });

  test('an ejected copy registered as `tools.memory` keeps its grants valid and quiet', () => {
    const raw = { default_agent: 'kortix', tools: { memory: 'tools/memory.ts' }, agents: { kortix: { mode: 'primary', tools: ['read', 'memory'] } } };
    const result = validateManifest(raw);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.path === 'agents.kortix.tools' || issue.path.startsWith('tools'))).toEqual([]);
  });

  test('`kortix validate --fix` drops the name, unless the project registers its own `memory` tool', () => {
    const plain = 'agents:\n  kortix:\n    prompt: x\n    tools: [read, memory]\n';
    expect(fixManifestText(plain)).toEqual({ text: 'agents:\n  kortix:\n    prompt: x\n    tools: [read]\n', fixed: [{ id: 'tool-retired', path: 'agents.kortix.tools' }] });
    const owned = 'tools:\n  memory: tools/memory.ts\nagents:\n  kortix:\n    prompt: x\n    tools: [read, memory]\n';
    expect(fixManifestText(owned)).toEqual({ text: owned, fixed: [] });
  });
});
