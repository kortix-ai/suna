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
  applyDefaultAgentV2,
  composeAgentConfigFiles,
  composeAgentRepairBehaviorFile,
  normalizeRequiredConnectorAliases,
  readAgentBlockV2,
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
      kortix_cli: ['project.cr.open'],
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

describe('composeAgentConfigFiles', () => {
  test('creates canonical manifest and behavior-file writes for a new v2 agent', () => {
    const result = composeAgentConfigFiles({
      manifest: v2Manifest(),
      agentName: 'reliance-cto',
      block: {
        enabled: true,
        connectors: ['github'],
        connectors_required: ['github'],
        kortix_cli: ['project.cr.open'],
        workspace: 'branch',
        opencode: {
          description: 'Reliance CTO',
          mode: 'primary',
          model: 'openai/gpt-4o',
          prompt: 'You are the Reliance CTO. Review technical work.',
        },
      },
      existingBehaviorFile: 'missing',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentName).toBe('reliance-cto');
    expect(result.manifestPath).toBe('kortix.yaml');
    expect(result.behaviorPath).toBe('.kortix/opencode/agents/reliance-cto.md');
    expect(result.files.map((file) => file.path)).toEqual([
      'kortix.yaml',
      '.kortix/opencode/agents/reliance-cto.md',
    ]);
    expect(result.manifestContent).toContain('reliance-cto');
    expect(result.behaviorMarkdown).toContain('description: Reliance CTO');
    expect(result.behaviorMarkdown).toContain('mode: primary');
    expect(result.behaviorMarkdown).toContain('You are the Reliance CTO.');
    expect(result.previewRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects an existing manifest agent', () => {
    const result = composeAgentConfigFiles({
      manifest: v2Manifest(),
      agentName: 'support',
      block: {
        opencode: { prompt: 'Support prompt.' },
      },
      existingBehaviorFile: 'missing',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('duplicate_agent');
    expect(result.status).toBe(409);
  });

  test('rejects an existing behavior file that has no matching manifest block', () => {
    const result = composeAgentConfigFiles({
      manifest: v2Manifest(),
      agentName: 'ghost',
      block: {
        opencode: { prompt: 'Ghost prompt.' },
      },
      existingBehaviorFile: 'exists',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('behavior_file_exists');
    expect(result.status).toBe(409);
  });

  test('rejects a create request with no prompt body', () => {
    const result = composeAgentConfigFiles({
      manifest: v2Manifest(),
      agentName: 'ghost',
      block: {
        opencode: { description: 'No prompt' },
      },
      existingBehaviorFile: 'missing',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('missing_prompt');
    expect(result.status).toBe(400);
  });
});

describe('composeAgentRepairBehaviorFile', () => {
  test('creates only a reviewed behavior-file write for a declared agent', () => {
    const result = composeAgentRepairBehaviorFile({
      manifest: v2Manifest(),
      agentName: 'support',
      behaviorFileState: 'missing',
      behaviorMarkdown:
        '---\ndescription: Support specialist\nmode: subagent\n---\n\nYou repair support tickets.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentName).toBe('support');
    expect(result.behaviorPath).toBe('.kortix/opencode/agents/support.md');
    expect(result.files).toEqual([
      {
        path: '.kortix/opencode/agents/support.md',
        content: result.behaviorMarkdown,
      },
    ]);
    expect(result.manifestPath).toBe('kortix.yaml');
    expect(result.behaviorMarkdown).toContain('description: Support specialist');
    expect(result.behaviorMarkdown).toContain('You repair support tickets.');
  });

  test('rejects repair when behavior markdown is empty', () => {
    const result = composeAgentRepairBehaviorFile({
      manifest: v2Manifest(),
      agentName: 'support',
      behaviorFileState: 'missing',
      behaviorMarkdown: '   ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('missing_behavior_markdown');
    expect(result.status).toBe(400);
  });

  test('rejects repair when the behavior file already exists', () => {
    const result = composeAgentRepairBehaviorFile({
      manifest: v2Manifest(),
      agentName: 'support',
      behaviorFileState: 'exists',
      behaviorMarkdown: 'You repair support tickets.',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('behavior_file_exists');
    expect(result.status).toBe(409);
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
