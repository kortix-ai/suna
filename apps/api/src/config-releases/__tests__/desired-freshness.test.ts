/**
 * `resolveDesiredRelease`'s mirror-refresh contract (KRTX-629).
 *
 * Default: the base tip is the upstream's, through the shared check
 * (`checkBase`, config-releases/base-tip.ts). `refreshProjectMirror: false` —
 * what `GET /config` passes, because its own etag compile refreshed the same
 * mirror moments earlier IN THE SAME REQUEST — reads the mirror as it is: a
 * second refresh made every read of the polled route pay a second sequential
 * `git fetch`.
 *
 * Every dep is injected, so these assert the DECISION, not the mirror.
 */
import { describe, expect, test } from 'bun:test';
import type { GitBackedProject } from '../../projects/git/types';
import type { ConfigRelease } from '../builder';
import { type DesiredReleaseDeps, resolveDesiredRelease } from '../desired';
import { MemoryConfigReleaseLedger } from './fakes';
import type { DeclaredAgentRoster } from '../session-agent';

const PROJECT: GitBackedProject = {
  projectId: '33333333-3333-4333-8333-333333333333',
  repoUrl: '/tmp/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  gitAuthToken: null,
};
const TIP = 'c'.repeat(40);
const ROSTER: DeclaredAgentRoster = {
  enabled: [],
  defaultAgent: null,
  readable: true,
  governed: false,
};

const RELEASE: ConfigRelease = {
  release_id: 'release',
  source_commit: TIP,
  config_dir: null,
  config_tree_id: null,
  archive: null,
  files: null,
  compiled_governance: '{}',
  compiled_governance_etag: 'etag',
  reason: null,
};

/** `calls` gets the project ID of every upstream check. */
function deps(calls: string[]): DesiredReleaseDeps {
  return {
    ledger: new MemoryConfigReleaseLedger(),
    build: async () => RELEASE,
    resolveBase: async () => TIP,
    readBase: async () => TIP,
    checkBase: async (project) => {
      calls.push(project.projectId);
      return TIP;
    },
    loadRoster: async () => ROSTER,
  };
}

describe('resolveDesiredRelease decides when to ask the upstream', () => {
  test('the default asks the shared check exactly once, for this project', async () => {
    const calls: string[] = [];
    await resolveDesiredRelease(
      { project: PROJECT, baseRef: 'main', sessionAgent: null, repositoryAccess: true },
      deps(calls),
    );
    expect(calls).toEqual([PROJECT.projectId]);
  });

  test('refreshProjectMirror: false never asks — the caller just refreshed', async () => {
    const calls: string[] = [];
    await resolveDesiredRelease(
      {
        project: PROJECT,
        baseRef: 'main',
        sessionAgent: null,
        repositoryAccess: true,
        refreshProjectMirror: false,
      },
      deps(calls),
    );
    expect(calls).toEqual([]);
  });

  test('an explicit true asks like the default', async () => {
    const calls: string[] = [];
    await resolveDesiredRelease(
      {
        project: PROJECT,
        baseRef: 'main',
        sessionAgent: null,
        repositoryAccess: true,
        refreshProjectMirror: true,
      },
      deps(calls),
    );
    expect(calls).toEqual([PROJECT.projectId]);
  });

  test('a boot whose tip the mirror already holds is answered without a forced fetch', async () => {
    const calls: string[] = [];
    const desired = await resolveDesiredRelease(
      { project: PROJECT, baseRef: 'main', sessionAgent: null, repositoryAccess: true, bootTip: TIP },
      deps(calls),
    );
    expect(calls).toEqual([]);
    expect(desired.baseSha).toBe(TIP);
  });

  test('a boot tip the mirror does not hold asks: the hint never chooses the release', async () => {
    const calls: string[] = [];
    const desired = await resolveDesiredRelease(
      { project: PROJECT, baseRef: 'main', sessionAgent: null, repositoryAccess: true, bootTip: 'd'.repeat(40) },
      deps(calls),
    );
    expect(calls).toEqual([PROJECT.projectId]);
    expect(desired.baseSha).toBe(TIP);
  });
});
