import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Every DB read the builder makes in these paths (build-log lookups) answers
// "no rows": a chain whose every call returns itself and which awaits to [].
function emptyQuery(): unknown {
  const chain: unknown = new Proxy(() => {}, {
    get: (_target, key) =>
      key === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : () => chain,
    apply: () => chain,
  });
  return chain;
}
mock.module('../shared/db', () => ({ db: emptyQuery() }));
// The cross-replica claim is its own DB suite (integration-snapshot-build-claim).
let peerHolds = false;
let peerFinishes = true;
mock.module('./build-claim', () => ({
  claimSnapshotBuild: async () => !peerHolds,
  releaseSnapshotBuild: async () => {},
  holdSnapshotBuild: () => () => {},
  waitForSnapshotBuildRelease: async () => {
    if (!peerFinishes) return;
    peerHolds = false;
    providerState = 'active';
  },
}));

const SERVING = 'kortix-default-serving';
const NEXT = 'kortix-default-next';
const template = {
  templateId: 'template-row',
  projectId: null,
  slug: 'default',
  name: 'Default',
  isShared: true,
  source: 'platform',
  provider: 'platinum',
  image: null,
  dockerfilePath: null,
  entrypoint: null,
  cpu: 2,
  memoryGb: 4,
  diskGb: 20,
  containerRuntime: false,
  providerState: 'active',
  providerSnapshotName: SERVING,
  contentHash: 'hash-serving',
  builtFromCommit: null,
  swapKey: null,
};

const recorded: string[] = [];
const failed: string[] = [];
const built: string[] = [];
const deleted: string[] = [];
const providers: string[] = [];
let providerState = 'missing';
let buildFails = false;

mock.module('./templates', () => ({
  resolveTemplateBySlug: async () => ({ ...template }),
  computeTemplateIdentity: async () => ({
    snapshotName: NEXT,
    contentHash: 'hash-next',
    shortHash: 'next',
    runtimeFingerprint: 'runtime-next',
    userDockerfile: 'FROM scratch',
    builtFromCommit: null,
    swapKey: 'swap-next',
  }),
  recordTemplateBuilt: async (_templateId: string, args: { snapshotName: string }) => {
    recorded.push(args.snapshotName);
  },
  recordTemplateFailed: async (_templateId: string, message: string) => {
    failed.push(message);
  },
  listTemplatesForProject: async () => [],
  resolveTemplateForBuildSlug: async () => ({ ...template }),
  refreshTemplateState: async () => {},
}));

mock.module('./providers', () => ({
  getSandboxProvider: (id: string) => {
    providers.push(id);
    return {
      id,
      isConfigured: () => true,
      getSnapshotState: async () => providerState,
      findFirstActiveSnapshot: async () => null,
      buildSnapshot: async (input: { snapshotName: string }) => {
        built.push(input.snapshotName);
        if (buildFails) throw new Error('provider build failed');
      },
      deleteSnapshot: async (name: string) => {
        deleted.push(name);
      },
    };
  },
}));

const { ensureSandboxImage, buildPlatformDefaultImageForRelease } = await import('./builder');
const project = { projectId: '', repoUrl: '', defaultBranch: '', manifestPath: '' };

beforeEach(() => {
  recorded.length = 0;
  failed.length = 0;
  built.length = 0;
  deleted.length = 0;
  providers.length = 0;
  providerState = 'missing';
  buildFails = false;
  peerHolds = false;
  peerFinishes = true;
});

describe('ensureSandboxImage across replicas', () => {
  test('another replica holds the build: this one builds nothing and serves the image it finished', async () => {
    peerHolds = true;
    const result = await ensureSandboxImage(project, { slug: 'default', source: 'startup', provider: 'platinum' });
    expect(built).toEqual([]);
    expect(result).toMatchObject({ snapshotName: NEXT, built: false });
  });

  test('the claim is lost again after one wait: a clear error, never a second same-name build', async () => {
    peerHolds = true;
    peerFinishes = false;
    await expect(
      ensureSandboxImage(project, { slug: 'default', source: 'startup', provider: 'platinum' }),
    ).rejects.toThrow('being built by another API replica');
    expect(built).toEqual([]);
  });
});

describe('ensureSandboxImage publication', () => {
  test('a published build repoints the row and prunes the predecessor (unchanged default)', async () => {
    const result = await ensureSandboxImage(project, {
      slug: 'default',
      source: 'startup',
      provider: 'platinum',
    });
    expect(result).toMatchObject({ snapshotName: NEXT, built: true });
    expect(built).toEqual([NEXT]);
    expect(recorded).toEqual([NEXT]);
    expect(deleted).toEqual([SERVING]);
  });

  test('an unpublished build leaves the row and the serving snapshot alone', async () => {
    const result = await ensureSandboxImage(project, {
      slug: 'default',
      source: 'startup',
      provider: 'platinum',
      publish: false,
    });
    expect(result).toMatchObject({ snapshotName: NEXT, built: true });
    expect(built).toEqual([NEXT]);
    expect(recorded).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test('an unpublished cache hit records nothing; a published one records the observation', async () => {
    providerState = 'active';
    await ensureSandboxImage(project, {
      slug: 'default',
      source: 'startup',
      provider: 'platinum',
      publish: false,
    });
    expect(recorded).toEqual([]);
    await ensureSandboxImage(project, { slug: 'default', source: 'startup', provider: 'platinum' });
    expect(recorded).toEqual([NEXT]);
    expect(built).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test('an unpublished build failure does not mark the serving row failed', async () => {
    buildFails = true;
    await expect(
      ensureSandboxImage(project, {
        slug: 'default',
        source: 'startup',
        provider: 'platinum',
        publish: false,
      }),
    ).rejects.toThrow('provider build failed');
    expect(failed).toEqual([]);
    await expect(
      ensureSandboxImage(project, { slug: 'default', source: 'startup', provider: 'platinum' }),
    ).rejects.toThrow('provider build failed');
    expect(failed).toEqual(['provider build failed']);
  });

  test('the release gate builds the platform default unpublished on the named provider', async () => {
    const result = await buildPlatformDefaultImageForRelease('platinum');
    expect(result).toMatchObject({ snapshotName: NEXT, built: true, isDefault: true });
    expect(new Set(providers)).toEqual(new Set(['platinum']));
    expect(recorded).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
