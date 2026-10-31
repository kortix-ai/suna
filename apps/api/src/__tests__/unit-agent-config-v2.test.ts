/**
 * Unit tests for the agent-block read/write lib (the "agent builder" backend's
 * kortix.yaml half). Pure functions — no DB, no git — so they exercise the
 * exact read/mutate/validate contract the GET/PUT routes depend on:
 *   - readAgentBlockV2: a block round-trips verbatim; a brand-new agent → null block.
 *   - applyAgentBlockV2: upserts the whole block and refuses a result that ADDS
 *     a validation error (bad enum / ungrantable action) — an error the file
 *     already had does not block an unrelated edit.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyAgentBlockV2,
  applyDefaultAgentV2,
  normalizeRequiredConnectorAliases,
  readAgentBlockV2,
} from '../projects/lib/agent-config-v2';
import { parseManifestString, synthesizeBlankManifest } from '../projects/triggers';
import { extractAgents } from '../projects/agents';

const V2 = `
default_agent: support
skills:
  pdf-export: skills/pdf-export
  web-research: skills/web-research
agents:
  support:
    connectors: [github]
    secrets: [STRIPE_KEY]
    skills: [pdf-export]
    kortix_permissions: [project.session.start]
    workspace: runtime
`;

function v2Manifest(body = V2) {
  return parseManifestString(body, 'kortix.yaml');
}

describe('readAgentBlockV2', () => {
  test('returns the full declared governance block verbatim for a v2 agent', () => {
    const read = readAgentBlockV2(v2Manifest(), 'support');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.defaultAgent).toBe('support');
    expect(read.block).toMatchObject({
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
      skills: ['pdf-export'],
      kortix_permissions: ['project.session.start'],
      repository_access: false,
    });
    expect(read.block).not.toHaveProperty('opencode');
    expect(read.block).not.toHaveProperty('description');
    expect(read.block).not.toHaveProperty('model');
  });

  test('returns a null block for an agent that is not declared yet (brand-new)', () => {
    const read = readAgentBlockV2(v2Manifest(), 'ghost');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.block).toBeNull();
  });

  test('normalizes the deprecated input alias in the response block', () => {
    const read = readAgentBlockV2(
      v2Manifest(`
default_agent: support
agents:
  support:
    connectors: [gmail]
    connectors_personal: [gmail]
`),
      'support',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.block?.connectors_required).toEqual(['gmail']);
    expect(read.block).not.toHaveProperty('connectors_personal');
  });

  test('rejects conflicting aliases instead of returning an ambiguous block', () => {
    const read = readAgentBlockV2(
      v2Manifest(`
default_agent: support
agents:
  support:
    connectors: [gmail, slack]
    connectors_required: [gmail]
    connectors_personal: [slack]
`),
      'support',
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toContain('must match');
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
    expect(agents.support.workspace).toEqual({ project_repository: true });
    expect(agents.support).not.toHaveProperty('repository_access');
    // Sibling agents / default_agent are untouched by a single-agent edit.
    expect(applied.raw.default_agent).toBe('support');
  });

  test('creates a brand-new agent block when the name is not declared yet', () => {
    const manifest = v2Manifest();
    const applied = applyAgentBlockV2(manifest, 'pr-bot', {
      connectors: ['github'],
      kortix_permissions: ['project.cr.open'],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const agents = applied.raw.agents as Record<string, unknown>;
    expect(Object.keys(agents).sort()).toEqual(['pr-bot', 'support']);
  });

  test('rejects an ungrantable kortix_permissions action', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', {
      kortix_permissions: ['billing.read'],
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix_permissions');
  });

  test('rejects an unknown workspace value', () => {
    const applied = applyAgentBlockV2(v2Manifest(), 'support', {
      workspace: 'everywhere' as never,
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('workspace');
  });

  test('refuses an edit that adds an error, accepts one that leaves an existing error alone', () => {
    const broken = v2Manifest(`
default_agent: support
agents:
  support: {}
  other:
    kortix_permissions: [billing.read]
`);
    // `other` already carries an error: editing `support` still saves.
    expect(applyAgentBlockV2(broken, 'support', { connectors: ['github'] }).ok).toBe(true);
    // A new error on `support` is refused, and only the new one is reported.
    const refused = applyAgentBlockV2(broken, 'support', { kortix_permissions: ['member.invite'] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.issues?.every((issue) => issue.path.startsWith('agents.support'))).toBe(true);
  });

  test('a retired-format file (kortix_version: 2) is refused until its body is valid', () => {
    const retired = v2Manifest('kortix_version: 2\nagents:\n  support: {}\n  other:\n    file: agents/other.md\n');
    const refused = applyAgentBlockV2(retired, 'support', { connectors: ['github'] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain('agents.other.file');
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
    expect(applied.error).toContain('"ghost" is not a declared agent');
  });

  test('rejects a disabled agent', () => {
    const applied = applyDefaultAgentV2(twoAgentManifest(), 'disabled');
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('the default agent must be enabled');
  });
});

describe('the synthesized manifest `loadManifestForEdit` produces for a blank project', () => {
  test('carries no kortix_version and accepts a default-agent and an agent-block write as-is', () => {
    const manifest = synthesizeBlankManifest({ name: 'blank-project', manifestPath: 'kortix.yaml' });
    expect(manifest.raw).not.toHaveProperty('kortix_version');
    expect(manifest.path).toBe('kortix.yaml');

    const applied = applyAgentBlockV2(manifest, 'release-bot', {
      connectors: ['github'],
      kortix_permissions: ['project.cr.open'],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(Object.keys(applied.raw.agents as Record<string, unknown>).sort()).toEqual(['release-bot', 'worker']);
    expect(applyDefaultAgentV2({ ...manifest, raw: applied.raw }, 'release-bot').ok).toBe(true);
  });
});

describe('connectors_required — the config route validation gate', () => {
  const manifestWith = (connectors: string[]) =>
    parseManifestString(
      ['default_agent: support', 'agents:', '  support:', `    connectors: [${connectors.join(', ')}]`, ''].join('\n'),
      'kortix.yaml',
    );

  test('a valid subset survives apply + re-parse with no errors', () => {
    const manifest = manifestWith(['gmail', 'slack']);
    const applied = applyAgentBlockV2(manifest, 'support', {
      connectors: ['gmail', 'slack'],
      connectors_required: ['gmail'],
    } as never);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const parsed = extractAgents({ ...manifest, raw: applied.raw });
    expect(parsed.errors).toEqual([]);
    expect(parsed.specs.find((s) => s.name === 'support')?.connectorsRequired).toEqual(['gmail']);
  });

  test('grant narrowing prunes required connectors before serialization', () => {
    const manifest = manifestWith(['gmail']);
    const applied = applyAgentBlockV2(manifest, 'support', {
      connectors: ['gmail'],
      connectors_required: ['slack'],
    } as never);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const block = (applied.raw.agents as Record<string, Record<string, unknown>>).support;
    expect(block).not.toHaveProperty('connectors_required');
  });

  test('the deprecated alias is imported and serialized as canonical', () => {
    const manifest = manifestWith(['gmail']);
    const applied = applyAgentBlockV2(manifest, 'support', {
      connectors: ['gmail'],
      connectors_personal: ['gmail'],
    } as never);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const block = (applied.raw.agents as Record<string, Record<string, unknown>>).support;
    expect(block.connectors_required).toEqual(['gmail']);
    expect(block).not.toHaveProperty('connectors_personal');
  });

  test('an explicit empty list survives request normalization so scope can clear it', () => {
    const normalized = normalizeRequiredConnectorAliases({ connectors_required: [] });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.block.connectors_required).toEqual([]);
  });
});


describe('repository access', () => {
  test('writes workspace.project_repository to kortix.yaml and reads it back as repository_access', () => {
    for (const value of [false, true]) {
      const saved = applyAgentBlockV2(v2Manifest(), 'support', { repository_access: value });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect((saved.raw.agents as any).support).toEqual({ workspace: { project_repository: value } });
      const read = readAgentBlockV2({ ...v2Manifest(), raw: saved.raw }, 'support');
      expect(read.ok && read.block).toEqual({ repository_access: value });
    }
  });
  test('writes an undeclared value explicitly as the default (false) and reads it back', () => {
    const saved = applyAgentBlockV2(v2Manifest(), 'support', { connectors: 'none' });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect((saved.raw.agents as any).support.workspace).toEqual({ project_repository: false });
    expect(extractAgents({ ...v2Manifest(), raw: saved.raw }).specs[0]?.repositoryAccess).toBe(false);
    const read = readAgentBlockV2(v2Manifest(V2.replace('    workspace: runtime\n', '')), 'support');
    expect(read.ok && read.block?.repository_access).toBe(false);
  });
  test('rejects conflicting aliases and invalid boolean values', () => {
    for (const block of [
      { repository_access: true, workspace: 'runtime' },
      { repository_access: 'false' },
      { repository_access: true, workspace: { project_repository: false } },
      { workspace: { project_repository: 'no' } },
      { workspace: { project_repo: false } },
    ]) {
      expect(applyAgentBlockV2(v2Manifest(), 'support', block as any).ok).toBe(false);
    }
  });
  test('keeps legacy read unavailable until a boolean is explicitly saved', () => {
    const saved = applyAgentBlockV2(v2Manifest(), 'support', { workspace: 'read' });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const agents = extractAgents({ ...v2Manifest(), raw: saved.raw });
    expect(agents.specs[0]?.legacyReadWorkspace).toBe(true);
    const resolved = applyAgentBlockV2({ ...v2Manifest(), raw: saved.raw }, 'support', { repository_access: false });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const updated = extractAgents({ ...v2Manifest(), raw: resolved.raw });
    expect(updated.specs[0]?.legacyReadWorkspace).toBe(false);
    expect(updated.specs[0]?.repositoryAccess).toBe(false);
  });
});
