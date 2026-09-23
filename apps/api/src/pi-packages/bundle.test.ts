import { describe, expect, test } from 'bun:test';
import { ensurePiPackageBundle, piPackageBundleDigest, piPackageBundleKey, piPackageSpecs, type BundleDeps } from './bundle';

describe('pi package bundle identity', () => {
  test('only exact npm pins count, sorted and unique; paths and junk are skipped', () => {
    expect(
      piPackageSpecs([
        'npm:pi-web-access@0.30.0',
        { source: 'npm:@juicesharp/rpiv-todo@1.2.0', skills: [] },
        './.kortix/pi/audit.ts',
        'npm:pi-web-access@0.30.0',
        'npm:unpinned',
        'npm:x@1.0.0;rm -rf /',
        null,
        42,
      ]),
    ).toEqual(['@juicesharp/rpiv-todo@1.2.0', 'pi-web-access@0.30.0']);
  });

  test('equal lists share one digest whatever the order; a version change moves it', () => {
    const a = piPackageBundleDigest(piPackageSpecs(['npm:a@1.0.0', 'npm:b@2.0.0']));
    expect(piPackageBundleDigest(piPackageSpecs(['npm:b@2.0.0', 'npm:a@1.0.0']))).toBe(a);
    expect(piPackageBundleDigest(piPackageSpecs(['npm:a@1.0.1', 'npm:b@2.0.0']))).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(piPackageBundleKey(a, '')).toBe(`pi-packages/pi-packages-v1/${a}.tar.gz`);
    // The same prefix project snapshots use, so one bucket policy covers both.
    expect(piPackageBundleKey(a, '/dev/')).toBe(`dev/pi-packages/pi-packages-v1/${a}.tar.gz`);
  });
});

describe('ensurePiPackageBundle', () => {
  function deps(state: { exists: boolean; builds: number; puts: string[]; cleanups: number; failPut?: boolean }): BundleDeps {
    return {
      head: async () => (state.exists ? {} : null),
      put: async (key) => {
        if (state.failPut) throw new Error('s3 down');
        state.puts.push(key);
      },
      build: async () => {
        state.builds++;
        await Bun.sleep(20);
        return { path: '/tmp/x.tar.gz', bytes: 1, cleanup: async () => void state.cleanups++ };
      },
    };
  }

  test('an existing bundle is not rebuilt', async () => {
    const state = { exists: true, builds: 0, puts: [] as string[], cleanups: 0 };
    await ensurePiPackageBundle(['a@1.0.0'], deps(state));
    expect(state.builds).toBe(0);
  });

  test('concurrent asks for one list build once and store it under its key', async () => {
    const state = { exists: false, builds: 0, puts: [] as string[], cleanups: 0 };
    const d = deps(state);
    await Promise.all([ensurePiPackageBundle(['b@1.0.0'], d), ensurePiPackageBundle(['b@1.0.0'], d)]);
    expect(state.builds).toBe(1);
    expect(state.puts).toEqual([piPackageBundleKey(piPackageBundleDigest(['b@1.0.0']))]);
    expect(state.cleanups).toBe(1);
  });

  test('a failed upload still removes the build and lets a later ask retry', async () => {
    const state = { exists: false, builds: 0, puts: [] as string[], cleanups: 0, failPut: true };
    await expect(ensurePiPackageBundle(['c@1.0.0'], deps(state))).rejects.toThrow('s3 down');
    expect(state.cleanups).toBe(1);
    state.failPut = false;
    await ensurePiPackageBundle(['c@1.0.0'], deps(state));
    expect(state.builds).toBe(2);
  });
});
