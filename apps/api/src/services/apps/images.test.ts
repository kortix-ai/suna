import { describe, expect, test } from 'bun:test';
import { SnapshotInUseError } from '../snapshots/providers/errors';
import {
  appDeploymentSnapshotName,
  deploymentIdFromAppSnapshotName,
} from '../snapshots/quota-gc-select';
import {
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
