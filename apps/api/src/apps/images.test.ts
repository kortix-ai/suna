import { describe, expect, test } from 'bun:test';
import { SnapshotInUseError } from '../snapshots/providers/errors';
import {
  appDeploymentSnapshotName,
  deploymentIdFromAppSnapshotName,
} from '../snapshots/quota-gc-select';
import {
  AppImageQuotaExceededError,
  appImageName,
  buildWithImageQuotaGuard,
  pinnedOciReference,
  reclaimAppDeploymentImages,
  releaseDeploymentImage,
  releaseDeploymentImages,
  removeAppRuntime,
  type AppImageProvider,
  type AppImageReclaimIo,
  type AppRuntimeTeardownTarget,
} from './images';

const DEPLOYMENT_A = '11111111-2222-4333-8444-555555555555';
const DEPLOYMENT_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const DEPLOYMENT_C = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const FOREIGN = '01234567-89ab-4cde-8f01-23456789abcd';

function fakeProvider(input: {
  images?: string[];
  inUse?: Set<string>;
  failDelete?: Set<string>;
  failList?: boolean;
  configured?: boolean;
} = {}): AppImageProvider & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    isConfigured: () => input.configured ?? true,
    async listSnapshots() {
      if (input.failList) throw new Error('provider listing 503');
      return (input.images ?? []).map((name) => ({ name }));
    },
    async deleteSnapshot(name) {
      if (input.inUse?.has(name)) throw new SnapshotInUseError(name, 1);
      if (input.failDelete?.has(name)) throw new Error(`delete ${name} -> 502`);
      deleted.push(name);
    },
  };
}

function fakeIo(input: {
  providers: Array<{ name: string; adapter: AppImageProvider }>;
  reclaimable?: string[];
  lookupFails?: boolean;
  lingering?: AppRuntimeTeardownTarget[];
  events?: string[];
  unusedImages?: Array<{ imageName: string; provider: string; outcome: 'released' | 'pending' | 'none' }>;
  sharedReleased?: string[];
}): AppImageReclaimIo & { lookups: string[][]; tornDown: string[] } {
  const lookups: string[][] = [];
  const tornDown: string[] = [];
  return {
    lookups,
    tornDown,
    providers: () => input.providers,
    async loadLingeringRuntimes(limit) {
      return (input.lingering ?? []).slice(0, limit);
    },
    async teardownRuntimes(runtimes) {
      input.events?.push('teardown');
      tornDown.push(...runtimes.map((runtime) => runtime.runtimeId));
      return { removed: runtimes.length, failed: 0 };
    },
    async loadReclaimableDeploymentIds(ids) {
      input.events?.push('lookup');
      lookups.push(ids);
      if (input.lookupFails) throw new Error('database unavailable');
      return new Set(ids.filter((id) => input.reclaimable?.includes(id)));
    },
    async loadUnusedImages(limit) {
      return (input.unusedImages ?? []).slice(0, limit);
    },
    async releaseImage(image) {
      input.sharedReleased?.push(image.imageName);
      return input.unusedImages?.find((row) => row.imageName === image.imageName)?.outcome ?? 'none';
    },
  };
}

describe('App deployment image names', () => {
  test('the deployment id round-trips through the image name', () => {
    expect(appDeploymentSnapshotName(DEPLOYMENT_A)).toBe('kortix-app-11111111222243338444555555555555');
    expect(deploymentIdFromAppSnapshotName(appDeploymentSnapshotName(DEPLOYMENT_A))).toBe(DEPLOYMENT_A);
  });

  test('a near-miss name maps to no deployment, so the sweep never touches it', () => {
    const exact = appDeploymentSnapshotName(DEPLOYMENT_A);
    expect(deploymentIdFromAppSnapshotName(`${exact}-old`)).toBeNull();
    expect(deploymentIdFromAppSnapshotName(exact.toUpperCase())).toBeNull();
    expect(deploymentIdFromAppSnapshotName(exact.replace('kortix-app-', 'kortix-tpl-'))).toBeNull();
    expect(deploymentIdFromAppSnapshotName(exact.slice(0, -1))).toBeNull();
    expect(deploymentIdFromAppSnapshotName('kortix-app-')).toBeNull();
  });
});

describe('releaseDeploymentImage', () => {
  test('a deployment that never reached a provider build has no image', async () => {
    const provider = fakeProvider();
    expect(await releaseDeploymentImage({ deploymentId: DEPLOYMENT_A, hostingProvider: null }, () => provider)).toBe('none');
    expect(provider.deleted).toEqual([]);
  });

  test('a provider this environment does not configure is not called', async () => {
    const provider = fakeProvider({ configured: false });
    expect(await releaseDeploymentImage({ deploymentId: DEPLOYMENT_A, hostingProvider: 'platinum' }, () => provider)).toBe('none');
    expect(provider.deleted).toEqual([]);
    expect(await releaseDeploymentImage(
      { deploymentId: DEPLOYMENT_A, hostingProvider: 'retired' },
      () => { throw new Error('Unknown sandbox provider: retired'); },
    )).toBe('none');
  });

  test('deletes the exact image the deployment worker built', async () => {
    const provider = fakeProvider();
    expect(await releaseDeploymentImage({ deploymentId: DEPLOYMENT_A, hostingProvider: 'platinum' }, () => provider)).toBe('released');
    expect(provider.deleted).toEqual([appDeploymentSnapshotName(DEPLOYMENT_A)]);
  });

  test('an image a sandbox still pins, or a failed provider call, is pending — never a throw', async () => {
    const pinned = fakeProvider({ inUse: new Set([appDeploymentSnapshotName(DEPLOYMENT_A)]) });
    expect(await releaseDeploymentImage({ deploymentId: DEPLOYMENT_A, hostingProvider: 'platinum' }, () => pinned)).toBe('pending');
    const failing = fakeProvider({ failDelete: new Set([appDeploymentSnapshotName(DEPLOYMENT_A)]) });
    expect(await releaseDeploymentImage({ deploymentId: DEPLOYMENT_A, hostingProvider: 'platinum' }, () => failing)).toBe('pending');
  });

  test('an App delete counts released and pending images across its deployments', async () => {
    const provider = fakeProvider({ inUse: new Set([appDeploymentSnapshotName(DEPLOYMENT_B)]) });
    const summary = await releaseDeploymentImages([
      { deploymentId: DEPLOYMENT_A, hostingProvider: 'platinum' },
      { deploymentId: DEPLOYMENT_B, hostingProvider: 'platinum' },
      { deploymentId: DEPLOYMENT_C, hostingProvider: 'platinum' },
      { deploymentId: FOREIGN, hostingProvider: null },
    ], () => provider);
    expect(summary).toEqual({ released: 2, pending: 1 });
    expect(provider.deleted.sort()).toEqual(
      [appDeploymentSnapshotName(DEPLOYMENT_A), appDeploymentSnapshotName(DEPLOYMENT_C)].sort(),
    );
  });
});

describe('removeAppRuntime', () => {
  const runtime: AppRuntimeTeardownTarget = { runtimeId: 'rt-1', provider: 'platinum', externalId: 'box-1' };

  test('a provider that 404s an already-deleted sandbox still counts it gone', async () => {
    const gone = await removeAppRuntime(runtime, () => ({
      remove: async () => { throw new Error('DELETE /v1/sandboxes/box-1 -> 404'); },
      getStatus: async () => 'removed',
    }) as never);
    expect(gone).toBe(true);
  });

  test('a sandbox the provider still holds is not counted gone, so its image stays protected', async () => {
    const gone = await removeAppRuntime(runtime, () => ({
      remove: async () => { throw new Error('DELETE /v1/sandboxes/box-1 -> 502'); },
      getStatus: async () => 'running',
    }) as never);
    expect(gone).toBe(false);
  });

  test('a retired provider cannot hold the delete hostage', async () => {
    expect(await removeAppRuntime(runtime, () => { throw new Error('provider disabled'); })).toBe(true);
  });
});

describe('reclaimAppDeploymentImages', () => {
  test('deletes only images whose deployment THIS database holds as unservable', async () => {
    const provider = fakeProvider({
      images: [
        appDeploymentSnapshotName(DEPLOYMENT_A),
        appDeploymentSnapshotName(DEPLOYMENT_B),
        appDeploymentSnapshotName(FOREIGN),
        'kortix-default-abc123',
        'daytonaio/stock-image',
      ],
    });
    const io = fakeIo({ providers: [{ name: 'platinum', adapter: provider }], reclaimable: [DEPLOYMENT_A] });
    const result = await reclaimAppDeploymentImages({}, io);
    expect(provider.deleted).toEqual([appDeploymentSnapshotName(DEPLOYMENT_A)]);
    // Only App images were looked up; a foreign environment's id is asked about
    // and comes back unknown, so it is never deleted.
    expect(io.lookups).toEqual([[DEPLOYMENT_A, DEPLOYMENT_B, FOREIGN]]);
    expect(result).toMatchObject({ providers: 1, listed: 3, reclaimable: 1, released: 1, pending: 0, errors: 0 });
  });

  test('an unreadable database deletes nothing', async () => {
    const provider = fakeProvider({ images: [appDeploymentSnapshotName(DEPLOYMENT_A)] });
    const io = fakeIo({ providers: [{ name: 'platinum', adapter: provider }], reclaimable: [DEPLOYMENT_A], lookupFails: true });
    const result = await reclaimAppDeploymentImages({}, io);
    expect(provider.deleted).toEqual([]);
    expect(result).toMatchObject({ released: 0, errors: 1 });
  });

  test('a failed provider listing skips that provider and still sweeps the others', async () => {
    const broken = fakeProvider({ failList: true });
    const healthy = fakeProvider({ images: [appDeploymentSnapshotName(DEPLOYMENT_B)] });
    const io = fakeIo({
      providers: [{ name: 'platinum', adapter: broken }, { name: 'daytona', adapter: healthy }],
      reclaimable: [DEPLOYMENT_B],
    });
    const result = await reclaimAppDeploymentImages({}, io);
    expect(healthy.deleted).toEqual([appDeploymentSnapshotName(DEPLOYMENT_B)]);
    expect(result).toMatchObject({ providers: 1, released: 1, errors: 1 });
  });

  test('a pinned image is pending and retried next pass, never counted released', async () => {
    const provider = fakeProvider({
      images: [appDeploymentSnapshotName(DEPLOYMENT_A)],
      inUse: new Set([appDeploymentSnapshotName(DEPLOYMENT_A)]),
    });
    const io = fakeIo({ providers: [{ name: 'platinum', adapter: provider }], reclaimable: [DEPLOYMENT_A] });
    const result = await reclaimAppDeploymentImages({}, io);
    expect(result).toMatchObject({ released: 0, pending: 1 });
  });

  test('one pass deletes at most maxPerPass images and reports the rest as deferred', async () => {
    const provider = fakeProvider({
      images: [DEPLOYMENT_A, DEPLOYMENT_B, DEPLOYMENT_C].map(appDeploymentSnapshotName),
    });
    const io = fakeIo({
      providers: [{ name: 'platinum', adapter: provider }],
      reclaimable: [DEPLOYMENT_A, DEPLOYMENT_B, DEPLOYMENT_C],
    });
    const result = await reclaimAppDeploymentImages({ maxPerPass: 1 }, io);
    expect(provider.deleted).toHaveLength(1);
    expect(result).toMatchObject({ reclaimable: 3, released: 1, deferred: 2 });
  });

  test('runtimes that still pin a reclaimable image are removed before images are looked up', async () => {
    const events: string[] = [];
    const provider = fakeProvider({ images: [appDeploymentSnapshotName(DEPLOYMENT_A)] });
    const io = fakeIo({
      providers: [{ name: 'platinum', adapter: provider }],
      reclaimable: [DEPLOYMENT_A],
      lingering: [{ runtimeId: 'rt-1', provider: 'platinum', externalId: 'box-1' }],
      events,
    });
    const result = await reclaimAppDeploymentImages({}, io);
    expect(events).toEqual(['teardown', 'lookup']);
    expect(io.tornDown).toEqual(['rt-1']);
    expect(result).toMatchObject({ runtimesRemoved: 1, released: 1 });
  });
});

const IMAGE_INPUTS = {
  environment: 'dev:https://api.example.test',
  accountId: '00000000-0000-4000-a000-0000000000a1',
  provider: 'platinum',
  artifactDigest: `sha256:${'ab'.repeat(32)}`,
  deploymentId: DEPLOYMENT_A,
  source: { kind: 'dockerfile', dockerfile: 'Dockerfile' },
  dockerfile: 'FROM node:22-alpine\nCOPY . /app\n',
  runtimeSpec: { port: 3000, healthPath: '/health' },
  machine: { cpuCores: 1, memoryGb: 2, diskGb: 10 },
  runtimeImageKey: 'appd-0123456789abcdef',
};

describe('shared App image names', () => {
  test('the same build inputs name the same image, whatever the deployment', () => {
    const first = appImageName(IMAGE_INPUTS);
    expect(first).toMatch(/^kortix-appimg-dev-[0-9a-f]{24}$/);
    expect(appImageName({ ...IMAGE_INPUTS, deploymentId: DEPLOYMENT_B })).toBe(first);
    // Key order in a spec object does not change the image.
    expect(appImageName({ ...IMAGE_INPUTS, runtimeSpec: { healthPath: '/health', port: 3000 } })).toBe(first);
  });

  test('every image-affecting input changes the name', () => {
    const base = appImageName(IMAGE_INPUTS);
    const variants = [
      { environment: 'staging:https://api.example.test' },
      { environment: 'dev:https://other.example.test' },
      { accountId: '00000000-0000-4000-a000-0000000000a2' },
      { provider: 'daytona' },
      { artifactDigest: `sha256:${'cd'.repeat(32)}` },
      { source: { kind: 'dockerfile', dockerfile: 'Dockerfile.prod' } },
      { dockerfile: 'FROM node:24-alpine\n' },
      { runtimeSpec: { port: 8080, healthPath: '/health' } },
      { machine: { cpuCores: 2, memoryGb: 2, diskGb: 10 } },
      { runtimeImageKey: 'appd-fedcba9876543210' },
    ];
    const names = variants.map((variant) => appImageName({ ...IMAGE_INPUTS, ...variant }));
    expect(new Set([base, ...names]).size).toBe(variants.length + 1);
    expect(names[0]).toStartWith('kortix-appimg-staging-');
  });

  test('an artifact without a fixed digest never shares an image', () => {
    const a = appImageName({ ...IMAGE_INPUTS, artifactDigest: null });
    const b = appImageName({ ...IMAGE_INPUTS, artifactDigest: null, deploymentId: DEPLOYMENT_B });
    expect(a).not.toBe(b);
  });

  test('only a digest-pinned OCI reference counts as fixed content', () => {
    const pinned = `ghcr.io/example/app@sha256:${'0f'.repeat(32)}`;
    expect(pinnedOciReference(pinned)).toBe(pinned);
    expect(pinnedOciReference('ghcr.io/example/app:latest')).toBeNull();
    expect(pinnedOciReference('docker.io/library/nginx:alpine')).toBeNull();
    expect(pinnedOciReference(null)).toBeNull();
  });
});

const PLATINUM_QUOTA = 'platinum POST /v1/templates/from-build -> 429 {"error":"org template quota reached (500/500); delete an existing template first","code":"org_template_quota_exceeded","quota":500,"used":500}';

describe('template quota guard', () => {
  test('a build that succeeds never reclaims', async () => {
    let reclaims = 0;
    await buildWithImageQuotaGuard({ provider: 'platinum', build: async () => {}, reclaim: async () => { reclaims += 1; } });
    expect(reclaims).toBe(0);
  });

  test('a quota refusal reclaims unused images once, then builds once more', async () => {
    const calls: string[] = [];
    let builds = 0;
    await buildWithImageQuotaGuard({
      provider: 'platinum',
      build: async () => {
        builds += 1;
        calls.push(`build${builds}`);
        if (builds === 1) throw new Error(PLATINUM_QUOTA);
      },
      reclaim: async () => { calls.push('reclaim'); },
      onReclaim: async (message) => { calls.push(message.includes('org_template_quota_exceeded') ? 'notice' : 'bad-notice'); },
    });
    expect(calls).toEqual(['build1', 'notice', 'reclaim', 'build2']);
  });

  test('a second quota refusal fails with app_image_quota_exceeded and an actionable message', async () => {
    let builds = 0;
    let reclaims = 0;
    const failure = await buildWithImageQuotaGuard({
      provider: 'platinum',
      build: async () => { builds += 1; throw new Error(PLATINUM_QUOTA); },
      reclaim: async () => { reclaims += 1; },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppImageQuotaExceededError);
    expect((failure as AppImageQuotaExceededError).code).toBe('app_image_quota_exceeded');
    expect((failure as Error).message).toContain('Delete unused Apps or deployments');
    expect(builds).toBe(2);
    expect(reclaims).toBe(1);
  });

  test('any other build failure passes through without a reclaim', async () => {
    let reclaims = 0;
    const failure = await buildWithImageQuotaGuard({
      provider: 'platinum',
      build: async () => { throw new Error('dockerfile: RUN npm ci exited 1'); },
      reclaim: async () => { reclaims += 1; },
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('dockerfile: RUN npm ci exited 1');
    expect(failure).not.toBeInstanceOf(AppImageQuotaExceededError);
    expect(reclaims).toBe(0);
  });
});

describe('shared image reclaim pass', () => {
  test('releases unused shared images with no provider listing, and counts what the provider kept', async () => {
    const released: string[] = [];
    const io = fakeIo({
      providers: [],
      unusedImages: [
        { imageName: 'kortix-appimg-dev-aaaaaaaaaaaaaaaaaaaaaaaa', provider: 'platinum', outcome: 'released' },
        { imageName: 'kortix-appimg-dev-bbbbbbbbbbbbbbbbbbbbbbbb', provider: 'platinum', outcome: 'pending' },
      ],
      sharedReleased: released,
    });
    const result = await reclaimAppDeploymentImages({}, io);
    expect(released).toEqual([
      'kortix-appimg-dev-aaaaaaaaaaaaaaaaaaaaaaaa',
      'kortix-appimg-dev-bbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(result).toMatchObject({ reclaimable: 2, released: 1, pending: 1, deferred: 0, errors: 0 });
  });

  test('one pass releases at most maxPerPass shared images', async () => {
    const released: string[] = [];
    const unusedImages = ['a', 'b', 'c'].map((letter) => ({
      imageName: `kortix-appimg-dev-${letter.repeat(24)}`,
      provider: 'platinum',
      outcome: 'released' as const,
    }));
    const result = await reclaimAppDeploymentImages({ maxPerPass: 2 }, fakeIo({ providers: [], unusedImages, sharedReleased: released }));
    expect(released).toHaveLength(2);
    expect(result).toMatchObject({ released: 2, deferred: 1 });
  });
});
