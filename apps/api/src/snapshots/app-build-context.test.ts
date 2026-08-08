import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageAppBuildContext } from './build-context';

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env.KORTIX_APPD_BIN_PATH;
  delete process.env.KORTIX_APP_CADDY_BIN_PATH;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('stageAppBuildContext', () => {
  test('preserves the source context and adds only the immutable App runtime layer', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'kortix-app-context-test-'));
    cleanup.push(fixture);
    const source = join(fixture, 'source');
    await mkdir(join(source, 'public'), { recursive: true });
    await writeFile(join(source, 'public', 'index.html'), '<h1>hello</h1>');
    for (const name of ['appd', 'caddy']) {
      await writeFile(join(fixture, name), name);
      await chmod(join(fixture, name), 0o755);
    }
    process.env.KORTIX_APPD_BIN_PATH = join(fixture, 'appd');
    process.env.KORTIX_APP_CADDY_BIN_PATH = join(fixture, 'caddy');

    const staged = await stageAppBuildContext(
      'kortix-app-test',
      'FROM scratch\nCOPY public /srv',
      {
        sourceDir: source,
        runtimeSpec: { static_root: '/srv', spa: true },
      },
    );
    cleanup.push(staged.contextDir);

    expect(await readFile(join(staged.contextDir, 'public', 'index.html'), 'utf8')).toBe(
      '<h1>hello</h1>',
    );
    const runtimeSpecPath = join(staged.contextDir, '.kortix-app-runtime', 'app.json');
    expect(JSON.parse(await readFile(runtimeSpecPath, 'utf8')))
      .toEqual({ static_root: '/srv', spa: true });
    expect((await stat(runtimeSpecPath)).mode & 0o777).toBe(0o644);
    const dockerfile = await readFile(staged.composedPath, 'utf8');
    expect(dockerfile).toContain('FROM scratch');
    expect(dockerfile).toContain('ENTRYPOINT ["/kortix/bin/kortix-appd"]');
    expect(dockerfile).toContain('EXPOSE 7331 8080');
    expect(dockerfile).not.toContain('KORTIX_APPD_TOKEN');
  });

  test('rejects a source path that can replace runtime files', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'kortix-app-context-test-'));
    cleanup.push(fixture);
    const source = join(fixture, 'source');
    await mkdir(join(source, '.kortix-app-runtime'), { recursive: true });
    for (const name of ['appd', 'caddy']) {
      await writeFile(join(fixture, name), name);
      await chmod(join(fixture, name), 0o755);
    }
    process.env.KORTIX_APPD_BIN_PATH = join(fixture, 'appd');
    process.env.KORTIX_APP_CADDY_BIN_PATH = join(fixture, 'caddy');

    await expect(
      stageAppBuildContext('kortix-app-test', 'FROM scratch', {
        sourceDir: source,
        runtimeSpec: { static_root: '/srv' },
      }),
    ).rejects.toThrow('reserved path');
  });
});
