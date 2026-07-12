/**
 * Unit tests for the v2 agent-block GOVERNANCE read/write lib (the "agent
 * builder" backend's kortix.yaml half — spec docs/specs/2026-07-05-agent-
 * first-config-unification.md §2.2, redirected 2026-07-05: "one home per
 * concern"). Pure functions — no DB, no git — so they exercise the exact
 * read/mutate/validate contract the GET/PUT routes depend on:
 *   - readAgentBlockV2: v2 block round-trips verbatim; v1 → null block +
 *     schemaVersion 1 (the UI's degrade signal); a brand-new agent → null block.
 *   - applyAgentBlockV2: upserts the whole block, validates the RESULT through
 *     the real manifest-schema validator (bad enum / ungrantable action /
 *     behavioral field → rejected), refuses a v1 manifest.
 *
 * Behavior (mode/model/temperature/permission/…) is NOT covered here — it
 * lives in the agent's `.md` frontmatter, exercised by
 * `../projects/lib/compile-agent-config.test.ts` and
 * `@kortix/manifest-schema`'s `validateAgentMdFrontmatter` tests instead.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyAgentBlockV2,
  applyAgentBlockV3,
  applyDefaultAgentV2,
  migrateManifestV2ToV3,
  readAgentBlockV2,
  readAgentBlockV3,
} from '../projects/lib/agent-config-v2';
import { parseManifestString } from '../projects/triggers';

const V2 = `
kortix_version: 2
default_agent: support
agents:
  support:
    connectors: [github]
    secrets: [STRIPE_KEY]
    skills: [pdf-export]
    kortix_cli: [project.session.start]
    workspace: runtime
`;

const V1 = `
kortix_version = 1
[project]
name = "acme"
[[agents]]
name = "kortix"
connectors = "all"
`;

const V3 = `
kortix_version: 3
default_agent: reviewer
runtimes:
  claude:
    harness: claude
    config_dir: .claude
  codex:
    harness: codex
agents:
  reviewer:
    runtime: codex
    connectors: [github]
  helper:
    runtime: claude
`;

function v2Manifest(body = V2) {
  return parseManifestString(body, 'yaml', 'kortix.yaml');
}

describe('readAgentBlockV2', () => {
  test('returns the full declared governance block verbatim for a v2 agent', () => {
    const read = readAgentBlockV2(v2Manifest(), 'support');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.schemaVersion).toBe(2);
    expect(read.defaultAgent).toBe('support');
    expect(read.block).toMatchObject({
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
      skills: ['pdf-export'],
      kortix_cli: ['project.session.start'],
      workspace: 'runtime',
    });
    expect(read.block).not.toHaveProperty('opencode');
    expect(read.block).not.toHaveProperty('description');
    expect(read.block).not.toHaveProperty('model');
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
  test('upserts an edited governance block and validates the resulting manifest', () => {
    const manifest = v2Manifest();
    const applied = applyAgentBlockV2(manifest, 'support', {
      connectors: 'all',
      secrets: 'none',
      skills: ['pdf-export', 'web-research'],
      workspace: 'branch',
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const agents = applied.raw.agents as Record<string, Record<string, unknown>>;
    expect(agents.support.connectors).toBe('all');
    expect(agents.support.secrets).toBe('none');
    expect(agents.support.skills).toEqual(['pdf-export', 'web-research']);
    expect(agents.support.workspace).toBe('branch');
    // Sibling agents / default_agent are untouched by a single-agent edit.
    expect(applied.raw.default_agent).toBe('support');
  });

  test('creates a brand-new agent block when the name is not declared yet', () => {
    const manifest = v2Manifest();
    const applied = applyAgentBlockV2(manifest, 'pr-bot', {
      connectors: ['github'],
      kortix_cli: ['project.cr.open'],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const agents = applied.raw.agents as Record<string, unknown>;
    expect(Object.keys(agents).sort()).toEqual(['pr-bot', 'support']);
  });

  test('rejects an ungrantable kortix_cli action', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', {
      kortix_cli: ['billing.read'],
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix_cli');
  });

  test('rejects an unknown workspace value', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', {
      workspace: 'everywhere' as never,
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('workspace');
  });

  test('rejects a behavioral field on the block — it belongs in the .md frontmatter now', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', {
      // @ts-expect-error — `mode` is no longer part of AgentBlockV2 (governance-only)
      mode: 'primary',
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('.md');
  });

  test('refuses a v1 manifest with an upgrade pointer (v2-only feature)', () => {
    const applied = applyAgentBlockV2(parseManifestString(V1, 'toml', 'kortix.toml'), 'kortix', {
      connectors: 'all',
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix_version 2');
  });

  test('rejects an invalid agent name', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'Not A Name', { connectors: 'all' });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('valid agent name');
  });
});

describe('applyDefaultAgentV2', () => {
  const twoAgentManifest = () =>
    v2Manifest(`
kortix_version: 2
default_agent: support
agents:
  support: {}
  reviewer: {}
  disabled:
    enabled: false
`);

  test('sets a declared enabled agent without changing the agent map', () => {
    const manifest = twoAgentManifest();
    const applied = applyDefaultAgentV2(manifest, 'reviewer');
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.raw.default_agent).toBe('reviewer');
    expect(applied.raw.agents).toEqual(manifest.raw.agents);
  });

  test('rejects an undeclared agent', () => {
    const applied = applyDefaultAgentV2(twoAgentManifest(), 'ghost');
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('does not match any declared agent');
  });

  test('rejects a disabled agent', () => {
    const applied = applyDefaultAgentV2(twoAgentManifest(), 'disabled');
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('disabled agent can never resolve as the default');
  });

  test('refuses a v1 manifest', () => {
    const applied = applyDefaultAgentV2(
      parseManifestString(V1, 'toml', 'kortix.toml'),
      'kortix',
    );
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix.yaml');
  });
});

describe('v3 ACP logical agent routing', () => {
  test('upgrades v2 governance without changing its initial OpenCode behavior binding', () => {
    const applied = migrateManifestV2ToV3(v2Manifest());
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.raw.kortix_version).toBe(3);
    expect(applied.raw).not.toHaveProperty('opencode');
    expect(applied.raw.runtimes).toEqual({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
      claude: { harness: 'claude', config_dir: '.claude' },
      codex: { harness: 'codex', config_dir: '.codex' },
      pi: { harness: 'pi', config_dir: '.pi' },
    });
    expect((applied.raw.agents as any).support).toMatchObject({
      runtime: 'opencode',
      agent: 'support',
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
    });
  });

  test('reads runtime profiles and the native agent id without behavior translation', () => {
    const read = readAgentBlockV3(parseManifestString(V3, 'yaml', 'kortix.yaml'), 'reviewer');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.block).toEqual({ runtime: 'codex', connectors: ['github'] });
    expect(read.runtimes).toMatchObject({
      claude: { harness: 'claude', config_dir: '.claude' },
      codex: { harness: 'codex' },
    });
  });

  test('switches a logical agent between native runtimes and preserves governance', () => {
    const manifest = parseManifestString(V3, 'yaml', 'kortix.yaml');
    const applied = applyAgentBlockV3(manifest, 'reviewer', {
      runtime: 'claude',
      connectors: ['github'],
      secrets: 'none',
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect((applied.raw.agents as any).reviewer).toEqual({
      runtime: 'claude',
      connectors: ['github'],
      secrets: 'none',
    });
  });

  test('rejects an undeclared runtime profile', () => {
    const applied = applyAgentBlockV3(
      parseManifestString(V3, 'yaml', 'kortix.yaml'),
      'reviewer',
      { runtime: 'missing' },
    );
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('does not match a declared runtime profile');
  });

  test('allows v3 to update the declared default agent', () => {
    const manifest = parseManifestString(V3, 'yaml', 'kortix.yaml');
    const applied = applyDefaultAgentV2(manifest, 'helper');
    expect(applied.ok).toBe(true);
    if (!applied.ok) expect.unreachable();
    else expect(applied.raw.default_agent).toBe('helper');
  });
});
