/**
 * Unit tests for the full v2 agent-block read/write lib (the "agent builder"
 * backend). Pure functions — no DB, no git — so they exercise the exact
 * read/mutate/validate contract the GET/PUT routes depend on:
 *   - readAgentBlockV2: v2 block round-trips verbatim; v1 → null block +
 *     schemaVersion 1 (the UI's degrade signal); a brand-new agent → null block.
 *   - applyAgentBlockV2: upserts the whole block, validates the RESULT through
 *     the real manifest-schema validator (bad permission tree / enum /
 *     ungrantable action → rejected), refuses a v1 manifest.
 */
import { describe, expect, test } from 'bun:test';
import { applyAgentBlockV2, readAgentBlockV2 } from '../projects/lib/agent-config-v2';
import { parseManifestString } from '../projects/triggers';

const V2 = `
kortix_version: 2
default_agent: support
agents:
  support:
    description: Handles support
    model: anthropic/claude-sonnet-5
    connectors: [github]
    secrets: [STRIPE_KEY]
    skills: [pdf-export]
    kortix_cli: [project.session.start]
    workspace: runtime
    opencode:
      mode: primary
      temperature: 0.2
      steps: 200
      color: "#7C5CFF"
      prompt: agents/support.md
      permission:
        edit: ask
        bash:
          "git push": deny
          "*": allow
`;

const V1 = `
kortix_version = 1
[project]
name = "acme"
[[agents]]
name = "kortix"
connectors = "all"
`;

function v2Manifest(body = V2) {
  return parseManifestString(body, 'yaml', 'kortix.yaml');
}

describe('readAgentBlockV2', () => {
  test('returns the full declared block verbatim for a v2 agent', () => {
    const read = readAgentBlockV2(v2Manifest(), 'support');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.schemaVersion).toBe(2);
    expect(read.defaultAgent).toBe('support');
    expect(read.block).toMatchObject({
      description: 'Handles support',
      model: 'anthropic/claude-sonnet-5',
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
      skills: ['pdf-export'],
      kortix_cli: ['project.session.start'],
      workspace: 'runtime',
      opencode: {
        mode: 'primary',
        temperature: 0.2,
        steps: 200,
        color: '#7C5CFF',
        prompt: 'agents/support.md',
      },
    });
    expect(read.block?.opencode?.permission).toEqual({
      edit: 'ask',
      bash: { 'git push': 'deny', '*': 'allow' },
    });
  });

  test('returns a null block for an agent that is not declared yet (brand-new)', () => {
    const read = readAgentBlockV2(v2Manifest(), 'ghost');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.schemaVersion).toBe(2);
    expect(read.block).toBeNull();
  });

  test('reports schemaVersion 1 + null block for a v1 manifest (the UI degrade signal)', () => {
    const read = readAgentBlockV2(parseManifestString(V1, 'toml', 'kortix.toml'), 'kortix');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.schemaVersion).toBe(1);
    expect(read.block).toBeNull();
  });
});

describe('applyAgentBlockV2', () => {
  test('upserts an edited block and validates the resulting manifest', () => {
    const manifest = v2Manifest();
    const applied = applyAgentBlockV2(manifest, 'support', {
      description: 'Now updated',
      opencode: {
        mode: 'primary',
        temperature: 0.9,
        permission: { edit: 'deny', webfetch: 'allow' },
      },
      connectors: 'all',
      secrets: 'none',
      skills: ['pdf-export', 'web-research'],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const agents = applied.raw.agents as Record<string, Record<string, unknown>>;
    expect(agents.support.description).toBe('Now updated');
    expect((agents.support.opencode as Record<string, unknown>).temperature).toBe(0.9);
    expect(agents.support.connectors).toBe('all');
    expect(agents.support.skills).toEqual(['pdf-export', 'web-research']);
    // Sibling agents / default_agent are untouched by a single-agent edit.
    expect(applied.raw.default_agent).toBe('support');
  });

  test('creates a brand-new agent block when the name is not declared yet', () => {
    const manifest = v2Manifest();
    const applied = applyAgentBlockV2(manifest, 'pr-bot', {
      description: 'Reviews PRs',
      opencode: { mode: 'subagent' },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const agents = applied.raw.agents as Record<string, unknown>;
    expect(Object.keys(agents).sort()).toEqual(['pr-bot', 'support']);
  });

  test('rejects an invalid permission action with the validator error (→ 400 upstream)', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', {
      opencode: { permission: { edit: 'maybe' as never } },
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('permission');
  });

  test('rejects a subagent with no description (schema cross-rule)', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', { opencode: { mode: 'subagent' } });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('description');
  });

  test('rejects an ungrantable kortix_cli action', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', {
      kortix_cli: ['billing.read'],
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix_cli');
  });

  test('rejects a bad color value', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', { opencode: { color: 'burple' } });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('color');
  });

  test('refuses a v1 manifest with an upgrade pointer (v2-only feature)', () => {
    const applied = applyAgentBlockV2(parseManifestString(V1, 'toml', 'kortix.toml'), 'kortix', {
      description: 'x',
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix_version 2');
  });

  test('rejects an invalid agent name', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'Not A Name', { opencode: { mode: 'primary' } });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('valid agent name');
  });
});
