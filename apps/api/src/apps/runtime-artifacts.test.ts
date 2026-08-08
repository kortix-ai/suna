import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appCaddyBinaryPath,
  appdBinaryPath,
  appRuntimeArtifactDigest,
} from './runtime-artifacts';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  appd: string;
  caddy: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-app-runtime-digest-'));
  cleanup.push(root);
  const appd = join(root, 'custom', 'appd');
  const caddy = join(root, 'custom', 'caddy');
  await mkdir(join(root, 'custom'), { recursive: true });
  await writeFile(appd, 'appd-v1');
  await writeFile(caddy, 'caddy-v1');
  return { root, appd, caddy };
}

describe('appRuntimeArtifactDigest', () => {
  test('honors explicit runtime binary environment paths', async () => {
    const files = await fixture();
    const previousAppd = process.env.KORTIX_APPD_BIN_PATH;
    const previousCaddy = process.env.KORTIX_APP_CADDY_BIN_PATH;
    process.env.KORTIX_APPD_BIN_PATH = files.appd;
    process.env.KORTIX_APP_CADDY_BIN_PATH = files.caddy;
    try {
      expect(appdBinaryPath()).toBe(files.appd);
      expect(appCaddyBinaryPath()).toBe(files.caddy);
    } finally {
      if (previousAppd === undefined) delete process.env.KORTIX_APPD_BIN_PATH;
      else process.env.KORTIX_APPD_BIN_PATH = previousAppd;
      if (previousCaddy === undefined) delete process.env.KORTIX_APP_CADDY_BIN_PATH;
      else process.env.KORTIX_APP_CADDY_BIN_PATH = previousCaddy;
    }
  });

  test('uses explicit runtime binary paths and changes when appd changes', async () => {
    const files = await fixture();
    const first = appRuntimeArtifactDigest({
      repoRoot: files.root,
      appdPath: files.appd,
      caddyPath: files.caddy,
    });

    await writeFile(files.appd, 'appd-v2');

    expect(appRuntimeArtifactDigest({
      repoRoot: files.root,
      appdPath: files.appd,
      caddyPath: files.caddy,
    })).not.toBe(first);
  });

  test('changes when Caddy changes', async () => {
    const files = await fixture();
    const first = appRuntimeArtifactDigest({
      repoRoot: files.root,
      appdPath: files.appd,
      caddyPath: files.caddy,
    });

    await writeFile(files.caddy, 'caddy-v2');

    expect(appRuntimeArtifactDigest({
      repoRoot: files.root,
      appdPath: files.appd,
      caddyPath: files.caddy,
    })).not.toBe(first);
  });

  test('falls back to runtime source when one binary is missing', async () => {
    const files = await fixture();
    const sourceFiles = [
      'apps/kortix-app-runtime/main.go',
      'apps/kortix-app-runtime/go.mod',
      'apps/kortix-app-runtime/caddy/main.go',
      'apps/kortix-app-runtime/caddy/go.mod',
      'apps/kortix-app-runtime/caddy/go.sum',
    ];
    for (const relative of sourceFiles) {
      const path = join(files.root, relative);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, relative);
    }
    await rm(files.caddy);

    const first = appRuntimeArtifactDigest({
      repoRoot: files.root,
      appdPath: files.appd,
      caddyPath: files.caddy,
    });
    await writeFile(join(files.root, sourceFiles[0]!), 'changed source');

    expect(appRuntimeArtifactDigest({
      repoRoot: files.root,
      appdPath: files.appd,
      caddyPath: files.caddy,
    })).not.toBe(first);
  });
});
