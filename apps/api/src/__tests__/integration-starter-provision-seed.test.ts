/**
 * P0 regression: POST /projects/provision (projects.ts) stamps
 * `metadata.require_declared_agents = true` on EVERY new project, but the
 * starter it seeded used to ship a manifest with no declared agents / no
 * `default_agent` — so a fresh project's first session (agent
 * `default`, the no-explicit-agent path every UI/CLI session takes) was
 * rejected with AGENT_NOT_DECLARED before a sandbox was ever provisioned.
 *
 * This exercises the closest testable seam to the real HTTP route: the exact
 * seed-building function projects.ts calls (`buildProjectSeedFiles`, same inputs a
 * web "Create project" request produces), then feeds its actual output
 * through the same manifest-parse -> agent-extraction -> grant-resolution
 * pipeline `sessions.ts` runs when a session is created. No DB/HTTP mocking
 * needed — the manifest content + resolution rule are pure.
 */
import { describe, expect, test } from 'bun:test';
import { validateManifest } from '@kortix/manifest-schema';
import { isMyKortixAgentName } from '@kortix/shared';
import { buildProjectSeedFiles } from '../projects/seed-files';
import { extractAgents, resolveGovernedAgentGrant } from '../projects/agents';
import { projectBuiltinAgents } from '../projects/lib/my-kortix-agent';
import { parseManifestString } from '../projects/triggers';

describe('buildProjectSeedFiles — the seeded manifest satisfies its own require_declared_agents stamp', () => {
  test('seeds a kortix.yaml with no kortix_version, and no kortix.toml', async () => {
    const seed = await buildProjectSeedFiles({
      projectName: 'Acme Co',
      repoFullName: 'kortix/acme-co',
      template: 'minimal',
      marketplaceItems: [],
      now: new Date('2026-07-05T00:00:00Z').toISOString(),
    });

    const manifest = seed.files.find((f) => f.path === 'kortix.yaml');
    expect(manifest).toBeDefined();
    expect(manifest?.content).not.toContain('kortix_version');
    expect(seed.files.some((f) => f.path === 'kortix.toml')).toBe(false);
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
    const result = validateManifest(manifestFile.content);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('a first session with no explicit agent runs My Kortix, and the worker it starts RESOLVES on a project stamped require_declared_agents:true — matches projects.ts /projects/provision + sessions.ts exactly', async () => {
    const seed = await buildProjectSeedFiles({
      projectName: 'Acme Co',
      repoFullName: 'kortix/acme-co',
      template: 'minimal',
      marketplaceItems: [],
      now: new Date('2026-07-05T00:00:00Z').toISOString(),
    });
    const manifestFile = seed.files.find((f) => f.path === 'kortix.yaml')!;
    const manifest = parseManifestString(manifestFile.content, 'kortix.yaml');
    const loaded = extractAgents(manifest);

    // The default is My Kortix: built in, turned on by the starter, and run by
    // session create with the platform grant, past the declared-agent check.
    expect(isMyKortixAgentName(loaded.defaultAgent ?? '')).toBe(true);
    expect(projectBuiltinAgents(manifest.raw).my_kortix).toBe(true);

    // projects.ts stamps require_declared_agents:true and never sets
    // metadata.default_agent — sessions.ts's projectDefaultAgent is therefore
    // null on a brand-new project's very first session.
    const governed = resolveGovernedAgentGrant('worker', loaded, {
      subject: true,
      projectDefaultAgent: null,
    });

    expect(governed.ok).toBe(true);
    if (!governed.ok) {
      throw new Error(`expected ok:true, got AGENT_NOT_DECLARED: ${governed.error}`);
    }
    expect(governed.grant).toEqual({
      agent: 'worker',
      connectors: 'all',
      permissions: 'all',
      env: 'all',
    });
  });

});
