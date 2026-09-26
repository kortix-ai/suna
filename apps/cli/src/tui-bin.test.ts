import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  cliVersion,
  downloadTuiBin,
  findTuiBin,
  isValidTuiVersion,
  managedTuiPath,
  parseSha256,
  removeTuiCache,
  tuiAssetUrl,
  tuiCacheRoot,
  tuiPlatformAsset,
  tuiReleaseBase,
  tuiReleaseTag,
} from './tui-bin.ts';

const BODY = new TextEncoder().encode('#!/not-really-a-binary\n');
const DIGEST = createHash('sha256').update(BODY).digest('hex');

function ok(body: Uint8Array | string): Response {
  return new Response(body as BodyInit, { status: 200 });
}

/** A fetch that answers the two release URLs and records what was asked for. */
function releaseFetch(
  answers: Record<string, Response | (() => Response)>,
  seen: string[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const answer = answers[url];
    if (!answer) return new Response('nope', { status: 404 });
    return typeof answer === 'function' ? answer() : answer;
  }) as unknown as typeof fetch;
}

describe('tui-bin — version validation', () => {
  test('accepts exactly a release version, with or without a tag', () => {
    expect(isValidTuiVersion('0.13.24')).toBe(true);
    expect(isValidTuiVersion('0.13.25-dev.abc12345')).toBe(true);
    expect(isValidTuiVersion('10.0.0-rc.1')).toBe(true);
  });

  test('rejects everything that could escape the cache path or redirect the URL', () => {
    // The version is spliced into a URL AND into a path under ~/.kortix.
    expect(isValidTuiVersion('../x')).toBe(false);
    expect(isValidTuiVersion('0.13.24/../../etc')).toBe(false);
    expect(isValidTuiVersion('0.13.24\n')).toBe(false);
    expect(isValidTuiVersion('https://evil.example/x')).toBe(false);
    expect(isValidTuiVersion('')).toBe(false);
    // `dev` is a real CLI version string and must NOT be downloadable.
    expect(isValidTuiVersion('dev')).toBe(false);
  });

  test('a malformed version never reaches the network', async () => {
    const seen: string[] = [];
    await expect(
      downloadTuiBin({
        version: '../x',
        fetchImpl: releaseFetch({}, seen),
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow('Refusing malformed kortix-tui version "../x"');
    expect(seen).toEqual([]);
  });
});

describe('tui-bin — asset names and URLs', () => {
  test('one asset per released target', () => {
    expect(tuiPlatformAsset('darwin', 'arm64')).toBe('kortix-tui-darwin-arm64');
    expect(tuiPlatformAsset('darwin', 'x64')).toBe('kortix-tui-darwin-x64');
    expect(tuiPlatformAsset('linux', 'x64')).toBe('kortix-tui-linux-x64');
    expect(tuiPlatformAsset('linux', 'arm64')).toBe('kortix-tui-linux-arm64');
  });

  test('an unreleased platform says what to do instead of guessing a URL', () => {
    expect(() => tuiPlatformAsset('win32', 'x64')).toThrow('No prebuilt kortix-tui binary');
    expect(() => tuiPlatformAsset('linux', 'riscv64')).toThrow('KORTIX_TUI_BIN');
  });

  test('a released version reads its own vX.Y.Z tag; a dev build reads dev-latest', () => {
    expect(tuiReleaseTag('0.13.24')).toBe('v0.13.24');
    // deploy-dev.yml publishes every dev CLI build to the mutable prerelease.
    expect(tuiReleaseTag('0.13.25-dev.abc12345')).toBe('dev-latest');
  });

  test('the asset URL is <base>/<tag>/<asset>, the scheme scripts/install.sh uses', () => {
    expect(tuiAssetUrl('0.13.24', 'kortix-tui-darwin-arm64', {})).toBe(
      'https://github.com/kortix-ai/suna/releases/download/v0.13.24/kortix-tui-darwin-arm64',
    );
  });

  test('KORTIX_TUI_RELEASE_BASE re-points the download and loses a trailing slash', () => {
    expect(tuiReleaseBase({ KORTIX_TUI_RELEASE_BASE: 'http://127.0.0.1:8123/' })).toBe(
      'http://127.0.0.1:8123',
    );
    expect(
      tuiAssetUrl('0.0.0-test', 'kortix-tui-linux-x64', {
        KORTIX_TUI_RELEASE_BASE: 'http://127.0.0.1:8123/',
      }),
    ).toBe('http://127.0.0.1:8123/v0.0.0-test/kortix-tui-linux-x64');
  });

  test('KORTIX_REPO re-points the release repo for a fork', () => {
    expect(tuiAssetUrl('1.2.3', 'kortix-tui-darwin-x64', { KORTIX_REPO: 'acme/suna' })).toBe(
      'https://github.com/acme/suna/releases/download/v1.2.3/kortix-tui-darwin-x64',
    );
  });
});

describe('tui-bin — resolution order', () => {
  const env = { KORTIX_TUI_DIR: '/cache', KORTIX_CLI_VERSION: '1.2.3' };

  test('1. KORTIX_TUI_BIN wins over everything, used as-is', () => {
    expect(
      findTuiBin({
        env: { ...env, KORTIX_TUI_BIN: '/opt/mine/kortix-tui' },
        exists: () => true,
      }),
    ).toEqual({ bin: '/opt/mine/kortix-tui', source: 'env' });
  });

  test('2. the managed cache for THIS CLI version', () => {
    const asked: string[] = [];
    expect(
      findTuiBin({
        env,
        exists: (path) => {
          asked.push(path);
          return true;
        },
      }),
    ).toEqual({ bin: '/cache/1.2.3/kortix-tui', source: 'cache' });
    expect(asked).toEqual(['/cache/1.2.3/kortix-tui']);
  });

  test('3. nothing on disk → null, so the caller can ask before downloading', () => {
    expect(findTuiBin({ env, exists: () => false })).toBeNull();
  });

  test('a source build reads ~/.kortix/tui/dev/kortix-tui with no env var at all', () => {
    expect(cliVersion({})).toBe(process.env.KORTIX_CLI_VERSION ?? 'dev');
    expect(findTuiBin({ env: { KORTIX_TUI_DIR: '/cache' }, exists: () => true })).toEqual({
      bin: '/cache/dev/kortix-tui',
      source: 'cache',
    });
  });

  test('a blank KORTIX_TUI_BIN is not an override', () => {
    expect(findTuiBin({ env: { ...env, KORTIX_TUI_BIN: '   ' }, exists: () => false })).toBeNull();
  });

  test('the cache root defaults under ~/.kortix, beside the managed opencode', () => {
    expect(tuiCacheRoot({})).toMatch(/\/\.kortix\/tui$/);
    expect(managedTuiPath('1.2.3', {})).toMatch(/\/\.kortix\/tui\/1\.2\.3\/kortix-tui$/);
  });
});

describe('tui-bin — download + checksum', () => {
  let dir: string;
  let env: Record<string, string>;
  let url: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kortix-tui-bin-'));
    env = { KORTIX_TUI_DIR: dir, KORTIX_TUI_RELEASE_BASE: 'http://127.0.0.1:9/rel' };
    url = 'http://127.0.0.1:9/rel/v1.2.3/kortix-tui-linux-x64';
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('downloads the binary + its .sha256 and installs it executable', async () => {
    const seen: string[] = [];
    const dest = await downloadTuiBin({
      version: '1.2.3',
      env,
      platform: 'linux',
      arch: 'x64',
      log: () => {},
      fetchImpl: releaseFetch(
        { [url]: () => ok(BODY), [`${url}.sha256`]: () => ok(`${DIGEST}  kortix-tui-linux-x64\n`) },
        seen,
      ),
    });
    expect(dest).toBe(join(dir, '1.2.3', 'kortix-tui'));
    expect(readFileSync(dest)).toEqual(Buffer.from(BODY));
    expect(statSync(dest).mode & 0o777).toBe(0o755);
    expect(seen).toEqual([url, `${url}.sha256`]);
  });

  test('a corrupted download is refused and leaves NOTHING behind', async () => {
    const wrong = createHash('sha256').update('something else').digest('hex');
    await expect(
      downloadTuiBin({
        version: '1.2.3',
        env,
        platform: 'linux',
        arch: 'x64',
        log: () => {},
        fetchImpl: releaseFetch({
          [url]: () => ok(BODY),
          [`${url}.sha256`]: () => ok(`${wrong}  kortix-tui-linux-x64\n`),
        }),
      }),
    ).rejects.toThrow(`checksum mismatch for kortix-tui-linux-x64 — expected ${wrong}`);
    // Not the binary, not a staging file: a later run must re-download, never
    // exec a half-written or tampered 80 MB file.
    expect(existsSync(join(dir, '1.2.3', 'kortix-tui'))).toBe(false);
    if (existsSync(join(dir, '1.2.3'))) {
      expect(readdirSync(join(dir, '1.2.3'))).toEqual([]);
    }
  });

  test('a missing checksum asset fails the install — it is not optional', async () => {
    await expect(
      downloadTuiBin({
        version: '1.2.3',
        env,
        platform: 'linux',
        arch: 'x64',
        log: () => {},
        fetchImpl: releaseFetch({ [url]: () => ok(BODY) }),
      }),
    ).rejects.toThrow('HTTP 404 (checksum is required)');
    expect(existsSync(join(dir, '1.2.3', 'kortix-tui'))).toBe(false);
  });

  test('a missing binary asset names the URL it asked for', async () => {
    await expect(
      downloadTuiBin({
        version: '1.2.3',
        env,
        platform: 'linux',
        arch: 'x64',
        log: () => {},
        fetchImpl: releaseFetch({}),
      }),
    ).rejects.toThrow(`${url} → HTTP 404`);
  });

  test('the sha256 asset is read as a sha256sum line', () => {
    expect(parseSha256(`${DIGEST}  kortix-tui-darwin-arm64\n`)).toBe(DIGEST);
    expect(parseSha256(DIGEST.toUpperCase())).toBe(DIGEST);
    expect(parseSha256('not a digest')).toBeNull();
    expect(parseSha256('abc123')).toBeNull();
  });

  test('removeTuiCache takes the whole managed directory', () => {
    mkdirSync(join(dir, '1.2.3'), { recursive: true });
    expect(existsSync(dir)).toBe(true);
    expect(removeTuiCache(env)).toBe(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('cliVersion inside a compiled binary', () => {
  /**
   * CI bakes the version with `bun build --define process.env.KORTIX_CLI_VERSION=…`.
   * The define substitutes only the literal token, so this test builds a real
   * bundle with it and runs the output with the variable UNSET: the launcher
   * must still answer the baked version, and an injected `env` must not hide it.
   * Restoring `env.KORTIX_CLI_VERSION ?? 'dev'` in cliVersion turns this red.
   */
  test('the baked define wins over an empty injected env and an unset variable', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'kortix-tui-bin-define-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(
        entry,
        `import { cliVersion } from ${JSON.stringify(resolve(import.meta.dir, 'tui-bin.ts'))};\n` +
          `console.log(JSON.stringify({ injectedEmpty: cliVersion({}), defaultEnv: cliVersion() }));\n`,
      );
      const out = join(dir, 'entry.js');
      const build = Bun.spawnSync(
        [
          'bun',
          'build',
          entry,
          '--target=bun',
          '--define',
          'process.env.KORTIX_CLI_VERSION="9.9.9-test.abc12345"',
          '--outfile',
          out,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(build.exitCode).toBe(0);
      const env = { ...process.env };
      delete env.KORTIX_CLI_VERSION;
      const run = Bun.spawnSync(['bun', out], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout.toString().trim())).toEqual({
        injectedEmpty: '9.9.9-test.abc12345',
        defaultEnv: '9.9.9-test.abc12345',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
