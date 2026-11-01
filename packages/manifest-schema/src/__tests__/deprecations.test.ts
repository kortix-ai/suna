/**
 * Every deprecation keeps old files working: the old shape validates with one
 * warning that names its fix, reads as the latest shape, and `--fix` writes a
 * file with no issue that keeps its comments. A new entry in DEPRECATIONS
 * without a case here fails the first test.
 */
import { describe, expect, test } from 'bun:test';
import { DEPRECATIONS, fixManifestText, parseManifestText, validateManifest } from '../index.ts';

/** id → [old file, path of the warning, the latest shape it reads as]. */
const CASES: Record<string, [string, string, Record<string, unknown>]> = {
  'drop-kortix-version': ['# keep me\nkortix_version: 3\nproject:\n  name: p\n', 'kortix_version', { project: { name: 'p' } }],
  'tools-explicit': ['agents:\n  a:\n    prompt: x\n', 'agents.a.tools', { agents: { a: { prompt: 'x', tools: 'all' } } }],
  'agent-disable': ['agents:\n  a:\n    prompt: x\n    tools: all\n    # keep me\n    disable: true\n', 'agents.a.disable', { agents: { a: { prompt: 'x', tools: 'all', enabled: false } } }],
  'agent-env': ['agents:\n  a:\n    prompt: x\n    tools: all\n    env: all\n', 'agents.a.env', { agents: { a: { prompt: 'x', tools: 'all', secrets: 'all' } } }],
  'agent-kortix-cli': ['agents:\n  a:\n    prompt: x\n    tools: all\n    kortix_cli: [project.file.read]\n', 'agents.a.kortix_cli', { agents: { a: { prompt: 'x', tools: 'all', kortix_permissions: ['project.file.read'] } } }],
  'agent-connectors-personal': [
    'connectors:\n  - slug: gh\n    provider: mcp\n    url: https://mcp.example.test\nagents:\n  a:\n    prompt: x\n    tools: all\n    connectors: [gh]\n    connectors_personal: [gh]\n',
    'agents.a.connectors_personal',
    { connectors: [{ slug: 'gh', provider: 'mcp', url: 'https://mcp.example.test' }], agents: { a: { prompt: 'x', tools: 'all', connectors: ['gh'], connectors_required: ['gh'] } } },
  ],
  'agent-repository-access': ['agents:\n  a:\n    prompt: x\n    tools: all\n    repository_access: true\n', 'agents.a.repository_access', { agents: { a: { prompt: 'x', tools: 'all', workspace: { project_repository: true } } } }],
  'agent-workspace-mode': ['agents:\n  a:\n    prompt: x\n    tools: all\n    workspace: branch\n', 'agents.a.workspace', { agents: { a: { prompt: 'x', tools: 'all', workspace: { project_repository: true } } } }],
  'sandbox-templates': ['sandboxes:\n  - slug: py\n    image: python:3.12-slim\n', 'sandboxes', { sandbox: { templates: [{ slug: 'py', image: 'python:3.12-slim' }] } }],
  'sandbox-singular': ['sandbox:\n  dockerfile: Dockerfile\n  context: .\n', 'sandbox', { sandbox: { templates: [{ slug: 'project', dockerfile: 'Dockerfile', context: '.' }], default: 'project' } }],
  'acp-runtimes': ['runtimes:\n  opencode:\n    harness: opencode\nagents:\n  a:\n    prompt: x\n    tools: all\n    runtime: opencode\n', 'runtimes', { agents: { a: { prompt: 'x', tools: 'all' } } }],
  'permission-renamed': ['agents:\n  a:\n    prompt: x\n    tools: all\n    kortix_permissions: [project.cr.open]\n', 'agents.a.kortix_permissions', { agents: { a: { prompt: 'x', tools: 'all', kortix_permissions: ['project.gitops.push'] } } }],
  'tool-retired': ['agents:\n  a:\n    prompt: x\n    tools: [web_search, kortix-connectors_call]\n', 'agents.a.tools', { agents: { a: { prompt: 'x', tools: ['web_search'] } } }],
};

test('every deprecation has a case', () => {
  expect(DEPRECATIONS.map((d) => d.id).sort()).toEqual(Object.keys(CASES).sort());
});

describe.each(Object.entries(CASES))('%s', (id, [old, path, latest]) => {
  test('the old shape validates: one warning, its fix and line, no error', () => {
    const result = validateManifest(old);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const warning = result.issues.find((i) => i.fix === id);
    expect(warning).toMatchObject({ path, severity: 'warning' });
    expect(warning?.line).toBeGreaterThan(0);
  });

  test('a reader gets the latest shape', () => {
    expect(parseManifestText(old)).toEqual(latest);
    expect(validateManifest(old).parsed).toEqual(latest);
  });

  test('--fix writes the latest shape with no issue and keeps comments', () => {
    const { text, fixed } = fixManifestText(old);
    expect(fixed.map((f) => f.id)).toContain(id);
    expect(validateManifest(text).issues).toEqual([]);
    for (const comment of old.match(/# .*/g) ?? []) expect(text).toContain(comment);
    expect(fixManifestText(text).text).toBe(text);
  });
});

test('--fix changes only the lines a deprecation changes: no folding, padding, spacing or indent changes', () => {
  const rest = [
    'project:',
    '  name: p   # two spaces before this comment',
    "  description: 'single quoted'",
    'agents:',
    '  a:',
    `    prompt: "${'x '.repeat(70).trim()}"`,
    '    tools: [read, bash]',
    '    workspace: { project_repository: true }',
    '    skills:',
    '    - one',
    '    - two',
    '    description: plain text that is quite long and goes well past the eighty character limit of the default',
    '',
  ].join('\n');
  expect(fixManifestText(`kortix_version: 3\n${rest}`).text).toBe(rest);
});

test('a conflict is not rewritten: it stays an error', () => {
  const result = validateManifest('agents:\n  a:\n    prompt: x\n    tools: all\n    kortix_cli: [project.file.read]\n    kortix_permissions: [project.read]\n');
  expect(result.issues.filter((i) => i.severity === 'error').map((i) => i.path)).toContain('agents.a.kortix_cli');
});
