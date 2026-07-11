/**
 * P0 regression: POST /projects/provision (r1.ts) stamps
 * `metadata.require_declared_agents = true` on EVERY new project, but the
 * starter it seeded used to ship a kortix_version 1 manifest with no declared
 * agents / no `default_agent` — so a fresh project's first session (agent
 * `default`, the no-explicit-agent path every UI/CLI session takes) was
 * rejected with AGENT_NOT_DECLARED before a sandbox was ever provisioned.
 *
 * This exercises the closest testable seam to the real HTTP route: the exact
 * seed-building function r1.ts calls (`buildProjectSeedFiles`, same inputs a
 * web "Create project" request produces), then feeds its actual output
 * through the same manifest-parse -> agent-extraction -> grant-resolution
 * pipeline `sessions.ts` runs when a session is created. No DB/HTTP mocking
 * needed — the manifest content + resolution rule are pure.
 */
import { describe, expect, test } from 'bun:test';
import { validateManifest } from '@kortix/manifest-schema';
import { buildProjectSeedFiles } from '../projects/seed-files';
import { extractAgents, resolveGovernedAgentGrant } from '../projects/agents';
import { parseManifestString } from '../projects/triggers';
import { compileRuntimeConfig } from '../projects/lib/compile-runtime-config';

describe('buildProjectSeedFiles — the seeded manifest satisfies its own require_declared_agents stamp', () => {
  test('seeds ACP-first kortix.yaml v3, not a v1 kortix.toml', async () => {
    const seed = await buildProjectSeedFiles({
      projectName: 'Acme Co',
      repoFullName: 'kortix/acme-co',
      template: 'minimal',
      marketplaceItems: [],
      now: new Date('2026-07-05T00:00:00Z').toISOString(),
    });

    expect(seed.files.some((f) => f.path === 'kortix.yaml')).toBe(true);
    expect(seed.files.some((f) => f.path === 'kortix.toml')).toBe(false);
    expect(seed.files.find((f) => f.path === 'kortix.yaml')?.content).toContain('kortix_version: 3');
  });

  test('the seeded manifest is schema-valid with zero errors', async () => {
    const seed = await buildProjectSeedFiles({
      projectName: 'Acme Co',
      repoFullName: 'kortix/acme-co',
      template: 'minimal',
      marketplaceItems: [],
      now: new Date('2026-07-05T00:00:00Z').toISOString(),
    });
    const manifestFile = seed.files.find((f) => f.path === 'kortix.yaml')!;
    const result = validateManifest(manifestFile.content, 'yaml');
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('a first session with no explicit agent (the "default" sentinel) RESOLVES on a project stamped require_declared_agents:true — matches r1.ts /projects/provision + sessions.ts exactly', async () => {
    const seed = await buildProjectSeedFiles({
      projectName: 'Acme Co',
      repoFullName: 'kortix/acme-co',
      template: 'minimal',
      marketplaceItems: [],
      now: new Date('2026-07-05T00:00:00Z').toISOString(),
    });
    const manifestFile = seed.files.find((f) => f.path === 'kortix.yaml')!;
    const manifest = parseManifestString(manifestFile.content, 'yaml', 'kortix.yaml');
    const loaded = extractAgents(manifest);

    // r1.ts stamps require_declared_agents:true and never sets
    // metadata.default_agent — sessions.ts's projectDefaultAgent is therefore
    // null on a brand-new project's very first session.
    const governed = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      projectDefaultAgent: null,
    });

    expect(governed.ok).toBe(true);
    if (!governed.ok) {
      throw new Error(`expected ok:true, got AGENT_NOT_DECLARED: ${governed.error}`);
    }
    expect(governed.grant?.agent).toBe('kortix');
  });

  test('the compiled v3 plan routes the starter through OpenCode ACP without translating its native config', async () => {
    const seed = await buildProjectSeedFiles({
      projectName: 'Acme Co',
      repoFullName: 'kortix/acme-co',
      template: 'minimal',
      marketplaceItems: [],
      now: new Date('2026-07-05T00:00:00Z').toISOString(),
    });
    const manifestFile = seed.files.find((f) => f.path === 'kortix.yaml')!;
    const manifest = parseManifestString(manifestFile.content, 'yaml', 'kortix.yaml');

    const compiled = compileRuntimeConfig(manifest.raw);
    expect(compiled?.kind).toBe('acp');
    if (compiled?.kind !== 'acp') return;
    expect(compiled.defaultAgent).toBe('kortix');
    expect(compiled.agents.kortix).toMatchObject({
      runtime: 'opencode',
      harness: 'opencode',
      nativeAgent: 'kortix',
      skills: 'all',
    });
    expect(compiled.runtimes).toMatchObject({
      claude: { harness: 'claude', configDir: '.claude' },
      codex: { harness: 'codex', configDir: '.codex' },
      opencode: { harness: 'opencode', configDir: '.kortix/opencode' },
      pi: { harness: 'pi', configDir: '.pi' },
    });
  });
});
