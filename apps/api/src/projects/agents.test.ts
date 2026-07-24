/**
 * `loadProjectAgents` — the declared-agent READ path `sessions.ts` actually
 * calls at session-create (via `resolveGovernedAgentGrant`), as opposed to
 * `loadManifestForEdit` (lib/triggers.ts), which only backs the agent-config
 * EDIT endpoints.
 *
 * PR #4974 fixed `loadManifestForEdit` to synthesize a v2 manifest with a
 * declared default agent for a blank managed-git project (no kortix.yaml/
 * kortix.toml committed yet — provisioned without `seed_starter:true`), but
 * left THIS path untouched: `loadProjectAgents` → `readManifest` (the plain
 * `../triggers.ts` reader, not the edit-time synthesis) returned a literal
 * `null` for a blank project, so `extractAgents` never ran and
 * `resolveGovernedAgentGrant` hit its `!declaredDefault` branch —
 * AGENT_NOT_DECLARED on the very first session-create, zero writes, live on
 * dev even after #4974 merged.
 *
 * `readManifestFromRepo` is the only I/O `readManifest` performs — mocked
 * here (same pattern as `lib/triggers.test.ts`) so the "brand-new repo, zero
 * files" case runs deterministically with no DB/network.
 */
import { describe, expect, mock, test } from 'bun:test';

let manifestFile: { path: string; content: string } | null = null;

// `./git` is a heavily-imported barrel (session-lifecycle, github, etc. pull
// other exports off it) — spread the REAL module and override only
// `readManifestFromRepo`, rather than replacing the whole module, so
// unrelated named exports the rest of the import graph needs stay intact.
const realGit = await import('./git');
mock.module('./git', () => ({
  ...realGit,
  readManifestFromRepo: async () => manifestFile,
}));

const { loadProjectAgents } = await import('./agents');
const { DEFAULT_AGENT_SENTINEL, resolveGovernedAgentGrant, personalConnectorsForAgent } =
  await import('./agents');

const fakeProject = () => ({
  projectId: 'proj_blank',
  repoUrl: 'https://github.com/acme/blank.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  gitAuthToken: null,
});

describe('loadProjectAgents — blank managed project (no manifest committed yet)', () => {
  test('synthesizes the same declared "kortix" default agent loadManifestForEdit promises', async () => {
    manifestFile = null; // brand-new repo, nothing committed yet

    const loaded = await loadProjectAgents(fakeProject());

    expect(loaded.errors).toEqual([]);
    expect(loaded.defaultAgent).toBe('kortix');
    expect(loaded.specs.map((s) => s.name)).toEqual(['kortix']);
    expect(loaded.specs[0]).toMatchObject({
      name: 'kortix',
      enabled: true,
      connectors: 'all',
      kortixCli: 'all',
      env: 'all',
    });
  });

  // GAP 1 (dev-live repro): sessions.ts resolves the launching agent through
  // exactly this loadProjectAgents → resolveGovernedAgentGrant chain, with
  // `subject: true` (every POST /projects/provision project stamps
  // `metadata.require_declared_agents = true`) and `projectDefaultAgent: null`
  // (project.metadata.default_agent is never stamped at provision time). This
  // is the REAL call shape session-create hits on a blank project's first
  // request with no agent forced — must resolve ok, never AGENT_NOT_DECLARED.
  test('closes gap 1: session-create\'s declared-agent check ("default" sentinel) now resolves ok', async () => {
    manifestFile = null;

    const loaded = await loadProjectAgents(fakeProject());
    const governed = resolveGovernedAgentGrant(DEFAULT_AGENT_SENTINEL, loaded, {
      subject: true,
      projectDefaultAgent: null,
    });

    expect(governed.ok).toBe(true);
    if (!governed.ok) return;
    expect(governed.grant).toEqual({
      agent: 'kortix',
      connectors: 'all',
      kortixCli: 'all',
      env: 'all',
    });
  });

  test('the synthesized "kortix" agent also resolves when named explicitly', async () => {
    manifestFile = null;

    const loaded = await loadProjectAgents(fakeProject());
    const governed = resolveGovernedAgentGrant('kortix', loaded, {
      subject: true,
      projectDefaultAgent: null,
    });

    expect(governed.ok).toBe(true);
  });

  test('an already-committed manifest is read as-is — unaffected by the synthesis fallback', async () => {
    manifestFile = {
      path: 'kortix.yaml',
      content: [
        'kortix_version: 2',
        'default_agent: support',
        'agents:',
        '  support:',
        '    connectors: [github]',
        '',
      ].join('\n'),
    };

    const loaded = await loadProjectAgents(fakeProject());

    expect(loaded.defaultAgent).toBe('support');
    expect(loaded.specs.map((s) => s.name)).toEqual(['support']);
  });
});

describe('connectors_personal — v2 agent personal-connector declaration', () => {
  test('parses a valid subset of the connectors grant, resolvable by name AND the default sentinel', async () => {
    manifestFile = {
      path: 'kortix.yaml',
      content: [
        'kortix_version: 2',
        'default_agent: support',
        'agents:',
        '  support:',
        '    connectors: [gmail, slack]',
        '    connectors_personal: [gmail]',
        '',
      ].join('\n'),
    };
    const loaded = await loadProjectAgents(fakeProject());
    expect(loaded.errors).toEqual([]);
    expect(loaded.specs.find((s) => s.name === 'support')?.connectorsPersonal).toEqual(['gmail']);
    expect(personalConnectorsForAgent('support', loaded)).toEqual(['gmail']);
    // the `default` sentinel resolves to the manifest's default_agent (support)
    expect(personalConnectorsForAgent(DEFAULT_AGENT_SENTINEL, loaded)).toEqual(['gmail']);
  });

  test('rejects a personal connector that is not in the connectors grant', async () => {
    manifestFile = {
      path: 'kortix.yaml',
      content: [
        'kortix_version: 2',
        'default_agent: support',
        'agents:',
        '  support:',
        '    connectors: [gmail]',
        '    connectors_personal: [slack]',
        '',
      ].join('\n'),
    };
    const loaded = await loadProjectAgents(fakeProject());
    expect(loaded.errors.length).toBeGreaterThan(0);
    expect(loaded.errors[0]?.error).toContain('subset of connectors');
  });

  test('an agent that declares none yields no personal connectors', async () => {
    manifestFile = {
      path: 'kortix.yaml',
      content: [
        'kortix_version: 2',
        'default_agent: support',
        'agents:',
        '  support:',
        '    connectors: [gmail]',
        '',
      ].join('\n'),
    };
    const loaded = await loadProjectAgents(fakeProject());
    expect(personalConnectorsForAgent('support', loaded)).toEqual([]);
  });
});
