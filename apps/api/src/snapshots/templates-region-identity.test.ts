import { expect, test } from 'bun:test';
import { computeSnapshotHash } from './hash';
import { maybeSwapAgent } from './runtime-images';
import type { SandboxProviderAdapter } from './providers';
import { computeTemplateIdentity, type ResolvedTemplate } from './templates';
import { PLATFORM_DEFAULT_USER_DOCKERFILE } from './dockerfile-layer';

const project = { projectId: 'proj_1', repoUrl: '', defaultBranch: 'main', manifestPath: 'kortix.yaml' };

function template(overrides: Partial<ResolvedTemplate> = {}): ResolvedTemplate {
  return {
    templateId: 'tmpl_1',
    projectId: 'proj_1',
    slug: 'app',
    name: 'app',
    isShared: false,
    source: 'toml',
    provider: 'platinum',
    image: 'ubuntu:24.04',
    dockerfilePath: null,
    entrypoint: null,
    cpu: 2,
    memoryGb: 4,
    diskGb: 20,
    containerRuntime: false,
    residentialProxy: null,
    providerState: 'active',
    providerSnapshotName: null,
    contentHash: null,
    builtFromCommit: null,
    swapKey: null,
    lastReady: {},
    ...overrides,
  };
}

const builtIn = (region: string | undefined) => ({ imageRegion: async () => region });

test('the region segment is hashed only when set', () => {
  const base = { dockerfile: 'FROM ubuntu:24.04\n', contextTreeOid: 'template:app', runtimeFingerprint: 'fp' };
  expect(computeSnapshotHash({ ...base, region: undefined }).contentHash).toBe(computeSnapshotHash(base).contentHash);
  expect(computeSnapshotHash({ ...base, region: 'us-east' }).contentHash).not.toBe(computeSnapshotHash(base).contentHash);
});

test('a project image built in us-east gets its own name and swap key', async () => {
  const home = await computeTemplateIdentity(project, template(), builtIn(undefined));
  const us = await computeTemplateIdentity(project, template(), builtIn('us-east'));
  expect(home.region).toBeUndefined();
  expect(us.region).toBe('us-east');
  expect(us.snapshotName).toStartWith('kortix-tpl-');
  expect(us.snapshotName).not.toBe(home.snapshotName);
  // An agent swap patches its predecessor where the predecessor lives, so a
  // region change must never pass the swap gate.
  expect(us.swapKey).not.toBe(home.swapKey);
});

test('a home-region project keeps the identity it had before regions existed', async () => {
  const home = await computeTemplateIdentity(project, template(), builtIn(undefined));
  const before = computeSnapshotHash({
    dockerfile: home.userDockerfile,
    contextTreeOid: 'template:app',
    spec: { cpu: 2, memory: 4, disk: 20 },
    containerRuntime: false,
    runtimeFingerprint: home.runtimeFingerprint,
  });
  expect(home.contentHash).toBe(before.contentHash);
});

test('the shared default is never regional and never reads the project', async () => {
  let reads = 0;
  const shared = await computeTemplateIdentity(project, template({ isShared: true, slug: 'default', image: null }), {
    imageRegion: async () => {
      reads += 1;
      return 'us-east';
    },
  });
  expect(reads).toBe(0);
  expect(shared.region).toBeUndefined();
  expect(shared.snapshotName).toStartWith('kortix-default-');
});

test('an agent swap names the region its predecessor was built in', async () => {
  const identity = await computeTemplateIdentity(project, template(), builtIn('us-east'));
  const swaps: Array<[string, string, { region?: string } | undefined]> = [];
  const provider = {
    id: 'platinum',
    getSnapshotState: async () => 'active',
    swapAgent: async (next: string, source: string, opts?: { region?: string }) => {
      swaps.push([next, source, opts]);
      return { externalTemplateId: 'tpl_next' };
    },
  } as unknown as SandboxProviderAdapter;
  const predecessor = template({ swapKey: identity.swapKey, providerSnapshotName: 'kortix-tpl-previous' });

  expect(await maybeSwapAgent(predecessor, identity, provider, 'kortix-tpl-previous')).toBe(true);
  expect(swaps).toEqual([[identity.snapshotName, 'kortix-tpl-previous', { region: 'us-east' }]]);
});

test('residential_proxy is a boot setting: it never changes the image identity', async () => {
  const off = await computeTemplateIdentity(project, template(), builtIn(undefined));
  for (const residentialProxy of [{}, { country: 'us' }]) {
    const on = await computeTemplateIdentity(project, template({ residentialProxy }), builtIn(undefined));
    expect(on.contentHash).toBe(off.contentHash);
    expect(on.snapshotName).toBe(off.snapshotName);
    expect(on.swapKey).toBe(off.swapKey);
  }
});

test('a template with neither image nor dockerfile builds the platform base as its own image', async () => {
  const identity = await computeTemplateIdentity(project, template({ image: null, dockerfilePath: null }), builtIn(undefined));
  expect(identity.userDockerfile).toBe(PLATFORM_DEFAULT_USER_DOCKERFILE);
  expect(identity.builtFromCommit).toBeNull();
  expect(identity.snapshotName).toStartWith('kortix-tpl-');
});
