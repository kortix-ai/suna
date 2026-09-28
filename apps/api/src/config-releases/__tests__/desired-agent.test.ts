/**
 * `resolveDesiredRelease` and the dropped agent (C10).
 *
 * Every dep is injected, so these assert the DECISION: which variant is built,
 * whether the column is written, and what the descriptor tells the session.
 * The persisted half runs for real in `tests/src/flows/config-releases.flow.ts`
 * (CFG-4).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { resolveDesiredRelease, type DesiredReleaseDeps } from '../desired';
import type { ConfigRelease, ConfigReleaseVariant } from '../builder';
import type { DeclaredAgentRoster } from '../session-agent';
import { MemoryConfigReleaseLedger } from '../quarantine';

const PROJECT = {
  projectId: '33333333-3333-4333-8333-333333333333',
  repoUrl: '/tmp/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  gitAuthToken: null,
};
const TIP = 'c'.repeat(40);

const ROSTER: DeclaredAgentRoster = {
  enabled: ['kortix', 'reviewer'],
  defaultAgent: 'kortix',
  readable: true,
  governed: true,
};

let built: ConfigReleaseVariant[] = [];

/** One release per variant, so the release ID proves which variant was built. */
function releaseFor(variant: ConfigReleaseVariant): ConfigRelease {
  return {
    format: 'config-release-v1',
    release_id: `${variant}-release`,
    source_commit: TIP,
    config_dir: '.kortix/opencode',
    config_tree_id: 'd'.repeat(40),
    archive: { url: '/archive', bytes: 10 },
    files: [['opencode.json', '100644', 'e'.repeat(40)]],
    compiled_governance: `{"variant":"${variant}"}`,
    compiled_governance_etag: `etag-${variant}`,
    reason: null,
  };
}

function deps(roster: DeclaredAgentRoster = ROSTER): DesiredReleaseDeps {
  return {
    ledger: new MemoryConfigReleaseLedger(),
    build: async (_project, _commit, variant) => {
      built.push(variant);
      return releaseFor(variant);
    },
    resolveBase: async () => TIP,
    loadRoster: async () => roster,
  };
}

beforeEach(() => {
  built = [];
});

describe('a declared agent is untouched', () => {
  test('repository access compiles every agent and reports no re-point', async () => {
    const desired = await resolveDesiredRelease(
      { project: PROJECT, baseRef: 'main', sessionAgent: 'reviewer', repositoryAccess: true },
      deps(),
    );
    expect(built).toEqual(['project']);
    expect(desired.descriptor.agent_repoint).toBeNull();
  });

  test('without repository access exactly its own agent is compiled', async () => {
    const desired = await resolveDesiredRelease(
      { project: PROJECT, baseRef: 'main', sessionAgent: 'reviewer', repositoryAccess: false },
      deps(),
    );
    expect(built).toEqual(['agent:reviewer']);
    expect(desired.variant).toBe('agent:reviewer');
  });

  test('the `default` sentinel resolves to the declared default and is not a re-point', async () => {
    const desired = await resolveDesiredRelease(
      { project: PROJECT, baseRef: 'main', sessionAgent: 'default', repositoryAccess: false },
      deps(),
    );
    expect(built).toEqual(['agent:kortix']);
    expect(desired.descriptor.agent_repoint).toBeNull();
  });
});

describe('the manifest dropped the session agent', () => {
  test('an authorized owner is re-pointed once, and the release is the default agent`s', async () => {
    const writes: Array<[string, string]> = [];
    const desired = await resolveDesiredRelease(
      {
        project: PROJECT,
        baseRef: 'main',
        sessionAgent: 'retired',
        repositoryAccess: false,
        ownerMayUseAgent: async () => true,
        persistRepoint: async (from, to) => {
          writes.push([from, to]);
          return true;
        },
      },
      deps(),
    );
    expect(writes).toEqual([['retired', 'kortix']]);
    expect(built).toEqual(['agent:kortix']);
    // Without repository access the descriptor's release ID covers the
    // governance alone, so the compiled governance is what proves the variant.
    expect(desired.descriptor.compiled_governance).toBe('{"variant":"agent:kortix"}');
    expect(desired.descriptor.agent_repoint).toMatchObject({
      from: 'retired',
      to: 'kortix',
      applied: true,
    });
    expect(desired.descriptor.agent_repoint!.reason).toContain('kortix');
  });

  // C10 — "Otherwise it keeps no access and says why."
  test('an owner who may not run the default agent keeps NONE of it, and is told', async () => {
    const writes: Array<[string, string]> = [];
    const desired = await resolveDesiredRelease(
      {
        project: PROJECT,
        baseRef: 'main',
        sessionAgent: 'retired',
        repositoryAccess: false,
        ownerMayUseAgent: async () => false,
        persistRepoint: async (from, to) => {
          writes.push([from, to]);
          return true;
        },
      },
      deps(),
    );
    // Nothing is written, and the default agent's config is never compiled —
    // compiling it would hand its prompt and model to an owner who may not run it.
    expect(writes).toEqual([]);
    expect(built).toEqual(['none']);
    expect(desired.descriptor.agent_repoint).toMatchObject({
      from: 'retired',
      to: 'kortix',
      applied: false,
    });
    expect(desired.descriptor.agent_repoint!.reason).toContain('may not run');
  });

  test('a caller that cannot ask the IAM question never widens anything', async () => {
    const desired = await resolveDesiredRelease(
      { project: PROJECT, baseRef: 'main', sessionAgent: 'retired', repositoryAccess: false },
      deps(),
    );
    expect(built).toEqual(['none']);
    expect(desired.descriptor.agent_repoint!.applied).toBe(false);
  });

  test('a project with no declared default leaves the session orphaned, never re-pointed', async () => {
    const desired = await resolveDesiredRelease(
      {
        project: PROJECT,
        baseRef: 'main',
        sessionAgent: 'retired',
        repositoryAccess: false,
        ownerMayUseAgent: async () => true,
      },
      deps({ ...ROSTER, defaultAgent: null }),
    );
    expect(built).toEqual(['none']);
    expect(desired.descriptor.agent_repoint).toMatchObject({ from: 'retired', to: null, applied: false });
  });

  // The whole point: no session ever ends up with `release_id: null` because
  // its agent was deleted.
  test('a release ID is never null because of a dropped agent', async () => {
    for (const roster of [ROSTER, { ...ROSTER, defaultAgent: null }]) {
      const desired = await resolveDesiredRelease(
        { project: PROJECT, baseRef: 'main', sessionAgent: 'retired', repositoryAccess: false },
        deps(roster),
      );
      expect(desired.descriptor.release_id).not.toBeNull();
      expect(desired.descriptor.reason).not.toContain('compiled governance failed');
    }
  });

  test('with repository access the variant is unchanged; only the column moves', async () => {
    const writes: Array<[string, string]> = [];
    const desired = await resolveDesiredRelease(
      {
        project: PROJECT,
        baseRef: 'main',
        sessionAgent: 'retired',
        repositoryAccess: true,
        ownerMayUseAgent: async () => true,
        persistRepoint: async (from, to) => {
          writes.push([from, to]);
          return true;
        },
      },
      deps(),
    );
    expect(built).toEqual(['project']);
    expect(writes).toEqual([['retired', 'kortix']]);
    expect(desired.descriptor.agent_repoint!.applied).toBe(true);
  });
});

describe('a read that cannot be trusted never re-points', () => {
  test('an unreadable manifest keeps the session on its own agent', async () => {
    const desired = await resolveDesiredRelease(
      {
        project: PROJECT,
        baseRef: 'main',
        sessionAgent: 'retired',
        repositoryAccess: false,
        ownerMayUseAgent: async () => true,
      },
      deps({ enabled: [], defaultAgent: null, readable: false, governed: false }),
    );
    expect(built).toEqual(['agent:retired']);
    expect(desired.descriptor.agent_repoint).toBeNull();
  });

  test('a project that declares no agents keeps the session on its own agent', async () => {
    const desired = await resolveDesiredRelease(
      {
        project: PROJECT,
        baseRef: 'main',
        sessionAgent: 'anything',
        repositoryAccess: false,
        ownerMayUseAgent: async () => true,
      },
      deps({ enabled: [], defaultAgent: null, readable: true, governed: false }),
    );
    expect(built).toEqual(['agent:anything']);
    expect(desired.descriptor.agent_repoint).toBeNull();
  });
});
