/**
 * Unit tests for the v2 agent-block GOVERNANCE read/write lib (the "agent
 * builder" backend's kortix.yaml half — redirected 2026-07-05: "one home per
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
  applyDefaultAgentV2,
  normalizeRequiredConnectorAliases,
  readAgentBlockV2,
  removeAgentBlockV2,
} from '../projects/lib/agent-config-v2';
import { parseManifestString, synthesizeBlankManifest } from '../projects/triggers';
import { extractAgents } from '../projects/agents';

const V2 = `
kortix_version: 2
default_agent: support
agents:
  support:
    connectors: [github]
    secrets: [STRIPE_KEY]
    skills: [pdf-export]
    kortix_permissions: [project.session.start]
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

  test('normalizes the deprecated input alias in the response block', () => {
    const read = readAgentBlockV2(
      v2Manifest(`
kortix_version: 2
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
kortix_version: 2
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

  test('rejects a behavioral field on the block — it belongs in the .md frontmatter now', () => {
    // `mode` is a behavioral field: the block must refuse it at runtime even
    // when a caller's type allows it, so pass it through an untyped object.
    const applied = applyAgentBlockV2(v2Manifest(), 'support', { mode: 'primary' } as never);
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
    const applied = applyDefaultAgentV2(parseManifestString(V1, 'toml', 'kortix.toml'), 'kortix');
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix_version 2');
  });
});

// GAP 2 (dev-live repro): `applyDefaultAgentV2`/`applyAgentBlockV2` validate
// via `validateManifest(manifest.raw, format)` — the RAW in-memory object,
// never through `serializeManifest`/re-parse (which re-injects
// `kortix_version` from `manifest.schemaVersion` on the way OUT — see that
// function's doc comment). `loadManifestForEdit`'s synthesized "blank
// project" manifest (no kortix.yaml/kortix.toml committed yet) is exactly
// this raw, never-serialized shape. #4974's own regression test proved the
// synthesis valid only via serialize→reparse→validate — never the raw path
// these two functions actually run — so it missed that the synthesized
// `.raw` never embedded `kortix_version`, and `validateRoot` (manifest-schema)
// rejects an object with no `kortix_version` key as unversioned before ever
// reaching the v2 body validators. PUT /default-agent and PUT
// /agents/:name/config both 400'd `kortix_version is required` on a blank
// project even after #4974 merged. `synthesizeBlankManifest` (../projects/
// triggers.ts) now embeds it — these tests exercise the EXACT functions the
// write routes call, on the EXACT object those routes hold (not a
// hand-rolled fixture), so a future regression that drops the key again
// fails here instead of shipping.
describe('the raw path `loadManifestForEdit` actually produces for a blank project', () => {
  test('applyDefaultAgentV2 validates against the synthesized manifest as-is (no serialize/reparse)', () => {
    const manifest = synthesizeBlankManifest({
      name: 'blank-project',
      manifestPath: 'kortix.toml',
    });
    // Sanity: the bug this guards against — a raw object with no
    // `kortix_version` key reads as unversioned to `validateRoot`.
    expect(manifest.raw.kortix_version).toBe(2);

    const applied = applyDefaultAgentV2(manifest, 'kortix');
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.raw.default_agent).toBe('kortix');
  });

  test('applyAgentBlockV2 validates a new agent block against the synthesized manifest as-is', () => {
    const manifest = synthesizeBlankManifest({
      name: 'blank-project',
      manifestPath: 'kortix.toml',
    });

    const applied = applyAgentBlockV2(manifest, 'release-bot', {
      connectors: ['github'],
      kortix_permissions: ['project.cr.open'],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const agents = applied.raw.agents as Record<string, unknown>;
    expect(Object.keys(agents).sort()).toEqual(['kortix', 'release-bot']);
    // The write result still carries kortix_version — a second edit in the
    // same request (or a subsequent PUT before the first commit lands) must
    // keep validating too, not just the very first one.
    expect(applied.raw.kortix_version).toBe(2);
    const reapplied = applyDefaultAgentV2({ ...manifest, raw: applied.raw }, 'release-bot');
    expect(reapplied.ok).toBe(true);
  });

  test('the synthesized manifest itself is schema-valid on the exact object identity applyDefaultAgentV2 spreads', () => {
    // `applyDefaultAgentV2`/`applyAgentBlockV2` both do `{ ...manifest.raw, ... }`
    // then `validateManifest(nextRaw, manifest.format)` directly — prove the
    // UNMODIFIED synthesized raw already round-trips through the real
    // validator with zero errors (a stricter check than the old test's
    // serialize→reparse indirection).
    const manifest = synthesizeBlankManifest({
      name: 'blank-project',
      manifestPath: 'kortix.toml',
    });
    const applied = applyDefaultAgentV2(manifest, manifest.raw.default_agent as string);
    expect(applied.ok).toBe(true);
  });
});

describe('connectors_required — the config route validation gate', () => {
  const manifestWith = (connectors: string[]) =>
    parseManifestString(
      ['kortix_version: 2', 'default_agent: support', 'agents:', '  support:', `    connectors: [${connectors.join(', ')}]`, ''].join('\n'),
      'yaml',
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
  test('writes an undeclared value explicitly as the v2 default (true) and reads it back', () => {
    const saved = applyAgentBlockV2(v2Manifest(), 'support', { connectors: 'none' });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect((saved.raw.agents as any).support.workspace).toEqual({ project_repository: true });
    expect(extractAgents({ ...v2Manifest(), raw: saved.raw }).specs[0]?.repositoryAccess).toBe(true);
    const read = readAgentBlockV2(v2Manifest(V2.replace('    workspace: runtime\n', '')), 'support');
    expect(read.ok && read.block?.repository_access).toBe(true);
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

describe('removeAgentBlockV2 (agent removal, KRTX-2085)', () => {
  const TWO_AGENTS = `
kortix_version: 2
default_agent: base
agents:
  base:
    connectors: all
  support:
    connectors: [github]
    file: agents/support.md
`;

  test('removes a declared agent and leaves the rest verbatim', () => {
    const saved = removeAgentBlockV2(v2Manifest(TWO_AGENTS), 'support');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(Object.keys(saved.raw.agents as object)).toEqual(['base']);
    // Removing a non-default agent never touches default_agent.
    expect(saved.newDefaultAgent).toBeNull();
    expect(saved.raw.default_agent).toBe('base');
    // The result must be a manifest the runtime accepts.
    const read = readAgentBlockV2({ ...v2Manifest(TWO_AGENTS), raw: saved.raw }, 'base');
    expect(read.ok && read.block?.connectors).toBe('all');
  });

  test('a removed agent is gone from the runtime agent list', () => {
    const saved = removeAgentBlockV2(v2Manifest(TWO_AGENTS), 'support');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const agents = extractAgents({ ...v2Manifest(TWO_AGENTS), raw: saved.raw });
    expect(agents.specs.map((s) => s.name).sort()).toEqual(['base']);
  });

  test('removing the default agent reassigns default_agent to the remaining agent', () => {
    const saved = removeAgentBlockV2(v2Manifest(TWO_AGENTS), 'base');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.newDefaultAgent).toBe('support');
    expect(saved.raw.default_agent).toBe('support');
  });

  test('reassignment prefers base over an earlier-sorted remaining name', () => {
    const manifest = `
kortix_version: 2
default_agent: gone
agents:
  gone: {}
  alpha: {}
  base: {}
`;
    const saved = removeAgentBlockV2(v2Manifest(manifest), 'gone');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.newDefaultAgent).toBe('base');
  });

  test('reassignment skips a disabled agent and picks an enabled one', () => {
    const manifest = `
kortix_version: 2
default_agent: gone
agents:
  gone: {}
  first:
    enabled: false
  second: {}
`;
    const saved = removeAgentBlockV2(v2Manifest(manifest), 'gone');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.newDefaultAgent).toBe('second');
  });

  test('refuses to remove the last declared agent (the manifest must keep one)', () => {
    const single = `
kortix_version: 2
default_agent: support
agents:
  support: {}
`;
    const saved = removeAgentBlockV2(v2Manifest(single), 'support');
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error).toMatch(/at least one agent/i);
  });

  test('refuses to remove the default agent when every remaining agent is disabled', () => {
    const manifest = `
kortix_version: 2
default_agent: gone
agents:
  gone: {}
  rest:
    enabled: false
`;
    const saved = removeAgentBlockV2(v2Manifest(manifest), 'gone');
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error).toMatch(/enabled agent/i);
  });

  test('a trigger bound to the removed agent fails validation (the manifest must stay valid)', () => {
    const manifest = `
kortix_version: 2
default_agent: base
agents:
  base: {}
  helper: {}
triggers:
  - slug: nightly
    type: schedule
    cron: "0 9 * * *"
    prompt: run
    agent: helper
`;
    const saved = removeAgentBlockV2(v2Manifest(manifest), 'helper');
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error).toMatch(/does not match any declared agent/);
  });

  test('refuses a v1 manifest (the [[agents]] array has no map semantics here)', () => {
    const saved = removeAgentBlockV2(parseManifestString(V1, 'toml', 'kortix.toml'), 'kortix');
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error).toMatch(/kortix_version 2 or later/);
  });

  test('an agent the manifest does not declare is a no-op, not an error', () => {
    const saved = removeAgentBlockV2(v2Manifest(TWO_AGENTS), 'ghost');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.raw.default_agent).toBe('base');
    expect(saved.newDefaultAgent).toBeNull();
  });
});
