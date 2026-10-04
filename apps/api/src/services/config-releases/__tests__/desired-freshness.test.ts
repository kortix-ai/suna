/**
 * `resolveDesiredRelease`'s mirror-refresh contract (KRTX-629).
 *
 * Default: the freshness stamp is dropped, so resolving the base tip fetches.
 * `refreshProjectMirror: false` — what `GET /config` passes, because its own
 * etag compile refreshed the same mirror moments earlier IN THE SAME REQUEST —
 * must not drop the stamp again: that second drop made every read of the
 * polled route pay a second sequential `git fetch`.
 *
 * Every dep is injected, so these assert the DECISION, not the mirror.
 */
import { describe, expect, test } from 'bun:test';
import type { GitBackedProject } from '../../git/types';
import type { ConfigRelease } from '../builder';
import { type DesiredReleaseDeps, resolveDesiredRelease } from '../desired';
import { MemoryConfigReleaseLedger } from '../quarantine';
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
  format: 'config-release-v1',
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

function deps(invalidated: string[]): DesiredReleaseDeps {
  return {
    ledger: new MemoryConfigReleaseLedger(),
    build: async () => RELEASE,
    resolveBase: async () => TIP,
    loadRoster: async () => ROSTER,
    invalidate: (projectId) => invalidated.push(projectId),
  };
}

describe('resolveDesiredRelease decides when to refresh the mirror', () => {
  test('the default refreshes exactly once, for this project', async () => {
    const calls: string[] = [];
    await resolveDesiredRelease(
      { project: PROJECT, baseRef: 'main', sessionAgent: null, repositoryAccess: true },
      deps(calls),
    );
    expect(calls).toEqual([PROJECT.projectId]);
  });

  test('refreshProjectMirror: false never invalidates — the caller just refreshed', async () => {
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

  test('an explicit true refreshes like the default', async () => {
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
});
