import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnv, ensurePiPackageBundle, missingPeers, piPackageBundleDigest, piPackageBundleKey, piPackageSpecs, type BundleDeps } from './bundle';

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
    expect(piPackageBundleKey(a, '')).toBe(`pi-packages/pi-packages-v3/${a}.tar.gz`);
    expect(piPackageBundleKey(a, '', 'node_modules')).toBe(`pi-packages/pi-packages-v3/${a}.node_modules.tar.gz`);
    // The same prefix project snapshots use, so one bucket policy covers both.
    expect(piPackageBundleKey(a, '/dev/')).toBe(`dev/pi-packages/pi-packages-v3/${a}.tar.gz`);
  });
});

describe('missingPeers', () => {
  test('required peers nobody installed; pi-supplied and optional peers never count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'peers-'));
    const pkg = async (name: string, manifest: object) => {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
    };
    try {
      await pkg('@acme/todo', {
        peerDependencies: { '@acme/i18n': '*', '@earendil-works/pi-coding-agent': '*', 'left-pad': '^1', maybe: '*', typebox: '*' },
        peerDependenciesMeta: { maybe: { optional: true } },
      });
      await pkg('left-pad', {});
      await pkg('typebox', {});
      expect(await missingPeers(root)).toEqual({ '@acme/i18n': '*' });
      expect(await missingPeers(join(root, 'absent'))).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('buildEnv — what the install and pre-build processes inherit', () => {
  test('only PATH, HOME, TMPDIR and registry settings: no NODE_PATH, no API secret', () => {
    const env = buildEnv({
      PATH: '/usr/bin',
      HOME: '/home/api',
      TMPDIR: '/tmp',
      NODE_PATH: '/repo/node_modules/.pnpm/node_modules',
      NPM_CONFIG_REGISTRY: 'https://registry.example',
      BUN_CONFIG_REGISTRY: 'https://registry.example',
      DATABASE_URL: 'postgres://secret',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/api', TMPDIR: '/tmp', NPM_CONFIG_REGISTRY: 'https://registry.example', BUN_CONFIG_REGISTRY: 'https://registry.example' });
  });

  test('an inherited NODE_PATH cannot pull a foreign module into a pre-build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prebuild-env-'));
    try {
      // A foreign `canvas` (as a monorepo's pnpm store has) whose native addon does not exist.
      await mkdir(join(root, 'foreign', 'canvas'), { recursive: true });
      await writeFile(join(root, 'foreign', 'canvas', 'package.json'), JSON.stringify({ name: 'canvas', version: '1.0.0', main: 'index.js' }));
      await writeFile(join(root, 'foreign', 'canvas', 'index.js'), "module.exports = require('../build/Release/canvas.node')");
      // An extension whose dependency needs canvas only optionally, like linkedom.
      const ext = join(root, 'node_modules', 'ext');
      await mkdir(ext, { recursive: true });
      await writeFile(join(ext, 'package.json'), JSON.stringify({ name: 'ext', version: '1.0.0', pi: { extensions: ['./index.js'] } }));
      await writeFile(join(ext, 'index.js'), "let canvas = null\ntry { canvas = require('canvas') } catch {}\nexport default () => canvas");
      const prebuild = async (env: Record<string, string>) => {
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'prebuild.ts'), join(root, 'node_modules'), join(root, `out-${Object.keys(env).length}`), 'ext'], { cwd: root, env, stdout: 'pipe' });
        return JSON.parse(await new Response(proc.stdout).text()).packages[0];
      };
      const leaky = await prebuild({ ...buildEnv(process.env), NODE_PATH: join(root, 'foreign') });
      expect(leaky.fallback).toContain('/foreign/canvas/index.js is outside the package install tree');
      expect(await prebuild(buildEnv({ ...process.env, NODE_PATH: join(root, 'foreign') }))).toMatchObject({ extensions: ['packages/ext/index.js.kortix.js'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
        return { prebuilt: { path: '/tmp/p.tar.gz', bytes: 1 }, nodeModules: { path: '/tmp/n.tar.gz', bytes: 2 }, cleanup: async () => void state.cleanups++ };
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
    const digest = piPackageBundleDigest(['b@1.0.0']);
    // The installed tree lands first: the pre-built key is the "complete" marker sessions check.
    expect(state.puts).toEqual([piPackageBundleKey(digest, undefined, 'node_modules'), piPackageBundleKey(digest)]);
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
