/**
 * Unit tests for the v2→v3 manifest migration edit-ops in `./agent-config-v2`
 * (Task WS1-P1-b). This is the safety net for the ~400k-user upgrade path:
 * `migrateManifestV2ToV3`, `applyRuntimeProfilesV3`, `readAgentBlockV3`, and
 * `applyAgentBlockV3` are exposed via `POST /runtime-profiles/enable` and the
 * agent-config editor routes (`../routes/agent-config.ts`).
 *
 * Companion to `../../__tests__/unit-agent-config-v2.test.ts` (which covers
 * the v2 governance read/write half plus a light smoke pass over v3). This
 * file goes deep on the migration contract itself: idempotence, losslessness,
 * re-validation, runtime-profile CRUD, and round-trip/negative behavior for
 * the v3 agent-block edit-ops — mirroring the local `describe`/`test` +
 * `parseManifestString` style used by `compile-runtime-config.test.ts` and
 * `session-runtime-env.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { stringify as stringifyYaml } from 'yaml';
import { validateManifest } from '@kortix/manifest-schema';
import {
  applyAgentBlockV3,
  applyRuntimeProfilesV3,
  DEFAULT_RUNTIME_PROFILES_V3,
  migrateManifestV2ToV3,
  readAgentBlockV3,
} from './agent-config-v2';
import { parseManifestString } from '../triggers';

// Representative v2 manifest: legacy top-level `opencode:` block, mixed
// per-agent grants (all / list / omitted), a `default_agent`, and a
// `triggers:` entry that references one of the agents.
const V2_MANIFEST = `
kortix_version: 2
default_agent: support
opencode:
  config_dir: .kortix/opencode
project:
  name: acme-support
agents:
  support:
    connectors: all
    secrets: [STRIPE_KEY]
    workspace: runtime
  reviewer:
    connectors: [github]
    kortix_cli: [project.cr.open]
    workspace: branch
  ghostwriter: {}
triggers:
  - slug: nightly-digest
    type: cron
    cron: "0 9 * * *"
    prompt: Summarize open PRs and support tickets
    agent: support
`;

function v2Manifest(body = V2_MANIFEST) {
  return parseManifestString(body, 'yaml', 'kortix.yaml');
}

// A v3 manifest built by hand (independent of the migration path) for the
// runtime-profile / agent-block edit-op tests below.
const V3_MANIFEST = `
kortix_version: 3
default_agent: kortix
project:
  name: acme-support
runtimes:
  opencode:
    harness: opencode
    config_dir: .kortix/opencode
  claude:
    harness: claude
    config_dir: .claude
  codex:
    harness: codex
    config_dir: .codex
  pi:
    harness: pi
    config_dir: .pi
agents:
  kortix:
    runtime: opencode
    agent: kortix
    connectors: all
triggers:
  - slug: nightly-digest
    type: cron
    cron: "0 9 * * *"
    prompt: Summarize open PRs
    agent: kortix
`;

function v3Manifest(body = V3_MANIFEST) {
  return parseManifestString(body, 'yaml', 'kortix.yaml');
}

/* ─── 1. migrateManifestV2ToV3 happy path ─────────────────────────────── */

describe('migrateManifestV2ToV3 — happy path', () => {
  test('promotes every v2 agent to routed v3, injects the four default runtime profiles, drops legacy opencode:, preserves governance/default_agent/triggers', () => {
    const applied = migrateManifestV2ToV3(v2Manifest());
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.raw.kortix_version).toBe(3);

    // Legacy top-level `opencode:` block is removed outright.
    expect(applied.raw).not.toHaveProperty('opencode');

    // All four default runtime profiles are injected with the canonical
    // harness + config_dir pairing (DEFAULT_RUNTIME_PROFILES_V3).
    expect(applied.raw.runtimes).toEqual({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
      claude: { harness: 'claude', config_dir: '.claude' },
      codex: { harness: 'codex', config_dir: '.codex' },
      pi: { harness: 'pi', config_dir: '.pi' },
    });
    expect(applied.raw.runtimes).toEqual(DEFAULT_RUNTIME_PROFILES_V3);

    // Every v2 agent is present, keyed by its own v2 map key, routed to
    // `runtime: opencode` / `agent: <its own key>`, with governance intact.
    const agents = applied.raw.agents as Record<string, Record<string, unknown>>;
    expect(Object.keys(agents).sort()).toEqual(['ghostwriter', 'reviewer', 'support']);

    expect(agents.support).toEqual({
      runtime: 'opencode',
      agent: 'support',
      connectors: 'all',
      secrets: ['STRIPE_KEY'],
      workspace: 'runtime',
    });
    expect(agents.reviewer).toEqual({
      runtime: 'opencode',
      agent: 'reviewer',
      connectors: ['github'],
      kortix_cli: ['project.cr.open'],
      workspace: 'branch',
    });
    // An agent with no v2 governance fields still gets routed correctly.
    expect(agents.ghostwriter).toEqual({ runtime: 'opencode', agent: 'ghostwriter' });

    // default_agent and triggers are untouched.
    expect(applied.raw.default_agent).toBe('support');
    expect(applied.raw.triggers).toEqual([
      {
        slug: 'nightly-digest',
        type: 'cron',
        cron: '0 9 * * *',
        prompt: 'Summarize open PRs and support tickets',
        agent: 'support',
      },
    ]);

    // Unrelated top-level sections (e.g. `project`) survive the migration.
    expect(applied.raw.project).toEqual({ name: 'acme-support' });
  });

  test('refuses a non-v2 (v1) manifest outright — this is strictly a v2→v3 upgrade', () => {
    const v1 = parseManifestString(
      `
kortix_version = 1
[project]
name = "acme"
[[agents]]
name = "kortix"
connectors = "all"
`,
      'toml',
      'kortix.toml',
    );
    const applied = migrateManifestV2ToV3(v1);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix_version 2');
  });
});

/* ─── 2. Idempotence ───────────────────────────────────────────────────── */

describe('migrateManifestV2ToV3 — idempotence', () => {
  test('refuses cleanly on its own output: the impl gates on schemaVersion === 2, so a v3 doc (schemaVersion 3) is rejected rather than re-migrated', () => {
    const firstPass = migrateManifestV2ToV3(v2Manifest());
    expect(firstPass.ok).toBe(true);
    if (!firstPass.ok) return;

    // Re-parse the migrated output the same way any caller would (fresh
    // ParsedManifest, schemaVersion now 3) and attempt to migrate again.
    const rehydrated = parseManifestString(
      stringifyYaml(firstPass.raw),
      'yaml',
      'kortix.yaml',
    );
    expect(rehydrated.schemaVersion).toBe(3);

    const secondPass = migrateManifestV2ToV3(rehydrated);
    expect(secondPass.ok).toBe(false);
    if (secondPass.ok) return;
    expect(secondPass.error).toBe('Only a kortix_version 2 manifest can be upgraded to v3.');
  });
});

/* ─── 3. Losslessness / round-trip ─────────────────────────────────────── */

describe('migrateManifestV2ToV3 — losslessness', () => {
  test('every agent name, grant set, workspace mode, and default_agent from the v2 input is recoverable from the v3 output', () => {
    const input = v2Manifest();
    const inputAgents = (input.raw.agents as Record<string, Record<string, unknown>>);

    const applied = migrateManifestV2ToV3(input);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const outputAgents = applied.raw.agents as Record<string, Record<string, unknown>>;

    expect(Object.keys(outputAgents).sort()).toEqual(Object.keys(inputAgents).sort());

    for (const [name, v2Block] of Object.entries(inputAgents)) {
      const v3Block = outputAgents[name];
      // Governance-relevant keys (everything except the routing keys the
      // migration itself adds) must deep-equal the v2 source verbatim.
      const { runtime: _runtime, agent: _agent, ...governance } = v3Block;
      expect(governance).toEqual(v2Block);
      // And the routing keys point back at this same agent.
      expect(v3Block.runtime).toBe('opencode');
      expect(v3Block.agent).toBe(name);
    }

    expect(applied.raw.default_agent).toBe(input.raw.default_agent);
  });
});

/* ─── 4. Validation ─────────────────────────────────────────────────────── */

describe('migrateManifestV2ToV3 — validation', () => {
  test('the migrated output passes validateManifest as v3 with zero issues', () => {
    const applied = migrateManifestV2ToV3(v2Manifest());
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const result = validateManifest(applied.raw, 'yaml');
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

/* ─── 5. applyRuntimeProfilesV3 ─────────────────────────────────────────── */

describe('applyRuntimeProfilesV3', () => {
  test('applies an add + an edit (config_dir change) + a delete in one call; the read-back shows exactly the applied set', () => {
    const manifest = v3Manifest();
    const nextRuntimes = {
      // unchanged
      opencode: { harness: 'opencode' as const, config_dir: '.kortix/opencode' },
      // edited: config_dir changed
      claude: { harness: 'claude' as const, config_dir: '.claude-team' },
      // unchanged
      pi: { harness: 'pi' as const, config_dir: '.pi' },
      // added
      'claude-fast': { harness: 'claude' as const, config_dir: '.claude-fast' },
      // `codex` is deleted by omission — no agent in this manifest uses it.
    };
    const applied = applyRuntimeProfilesV3(manifest, nextRuntimes);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // Direct-parse read-back (the same shape the GET /runtime-profiles route
    // hands back verbatim from `manifest.raw.runtimes`).
    expect(applied.raw.runtimes).toEqual(nextRuntimes);
    expect(applied.raw.runtimes).not.toHaveProperty('codex');
    // Everything else on the manifest is untouched.
    expect(applied.raw.agents).toEqual(manifest.raw.agents);
    expect(applied.raw.default_agent).toBe('kortix');
  });

  test('rejects an unknown-harness profile with the validator issue shape (path + message), not a throw', () => {
    const manifest = v3Manifest();
    const applied = applyRuntimeProfilesV3(manifest, {
      opencode: { harness: 'opencode' as const, config_dir: '.kortix/opencode' },
      bogus: { harness: 'not-a-real-harness' as never },
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('harness must be one of');
    expect(applied.issues).toBeDefined();
    expect(applied.issues?.some((i) => i.path === 'runtimes.bogus.harness' && i.severity === 'error')).toBe(true);
  });

  test('refuses on a non-v3 manifest', () => {
    const applied = applyRuntimeProfilesV3(v2Manifest(), DEFAULT_RUNTIME_PROFILES_V3);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('kortix_version 3');
  });
});

/* ─── 6. readAgentBlockV3 / applyAgentBlockV3 round-trip ───────────────── */

describe('readAgentBlockV3 / applyAgentBlockV3 — round-trip', () => {
  test('a full write (runtime/agent/enabled/grants/workspace) reads back deep-equal', () => {
    const manifest = v3Manifest();
    const block = {
      runtime: 'claude',
      agent: 'native-claude-profile',
      enabled: true,
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
      skills: ['pdf-export'],
      kortix_cli: ['project.cr.open'],
      workspace: 'branch' as const,
    };
    const applied = applyAgentBlockV3(manifest, 'kortix', block);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const rehydrated = { ...manifest, raw: applied.raw };
    const read = readAgentBlockV3(rehydrated, 'kortix');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.block).toEqual(block);
  });

  test('editing one field (runtime) leaves every other field on that block unchanged', () => {
    const manifest = v3Manifest();
    const original = readAgentBlockV3(manifest, 'kortix');
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    expect(original.block).toEqual({ runtime: 'opencode', agent: 'kortix', connectors: 'all' });

    const applied = applyAgentBlockV3(manifest, 'kortix', {
      ...(original.block as NonNullable<typeof original.block>),
      runtime: 'claude',
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const rehydrated = { ...manifest, raw: applied.raw };
    const read = readAgentBlockV3(rehydrated, 'kortix');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.block).toEqual({ runtime: 'claude', agent: 'kortix', connectors: 'all' });
  });

  test('unrelated top-level sections and sibling agents are preserved semantically (raw is a plain parsed object — the yaml/toml parsers used here have no comment-preserving CST, so this is semantic, not byte-formatting, preservation)', () => {
    const manifest = v3Manifest(`
kortix_version: 3
default_agent: kortix
project:
  name: acme-support
runtimes:
  opencode:
    harness: opencode
    config_dir: .kortix/opencode
agents:
  kortix:
    runtime: opencode
    agent: kortix
    connectors: all
  helper:
    runtime: opencode
    workspace: read
triggers:
  - slug: nightly-digest
    type: cron
    cron: "0 9 * * *"
    prompt: Summarize open PRs
    agent: kortix
`);
    const applied = applyAgentBlockV3(manifest, 'kortix', { runtime: 'opencode', agent: 'kortix', connectors: 'none' });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // The sibling agent block, project section, triggers, and runtimes map
    // are all untouched by editing only `kortix`.
    expect((applied.raw.agents as Record<string, unknown>).helper).toEqual(manifest.raw.agents && (manifest.raw.agents as Record<string, unknown>).helper);
    expect(applied.raw.project).toEqual(manifest.raw.project);
    expect(applied.raw.triggers).toEqual(manifest.raw.triggers);
    expect(applied.raw.runtimes).toEqual(manifest.raw.runtimes);
  });
});

/* ─── 7. Negative: undeclared runtime profile ───────────────────────────── */

describe('applyAgentBlockV3 — negative: undeclared runtime reference', () => {
  test('an agent block whose `runtime` names a profile absent from `runtimes` is rejected with an issue list, not a throw', () => {
    const manifest = v3Manifest();
    const applied = applyAgentBlockV3(manifest, 'kortix', { runtime: 'gpt5-experimental' });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toContain('does not match a declared runtime profile');
    expect(applied.issues).toBeDefined();
    expect(
      applied.issues?.some(
        (i) => i.path === 'agents.kortix.runtime' && i.severity === 'error',
      ),
    ).toBe(true);
  });
});
