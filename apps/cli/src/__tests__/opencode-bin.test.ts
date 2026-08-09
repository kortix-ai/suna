import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';

import {
  ensureOpencodeBin,
  managedOpencodePath,
  opencodePlatformPackage,
  parseOpencodeVersion,
} from '../opencode-bin.ts';

const savedEnv: Record<string, string | undefined> = {};
let scratch: string;

beforeEach(() => {
  for (const key of ['KORTIX_OPENCODE_BIN', 'KORTIX_OPENCODE_DIR']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  scratch = mkdtempSync(join(tmpdir(), 'opencode-bin-test-'));
  process.env.KORTIX_OPENCODE_DIR = join(scratch, 'managed');
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const neverFetch: typeof fetch = (() => {
  throw new Error('unexpected network call');
}) as unknown as typeof fetch;

const noPathBinary = () => null;

async function makeTarball(executableContent: string): Promise<string> {
  const stage = join(scratch, 'tarball-stage');
  mkdirSync(join(stage, 'package', 'bin'), { recursive: true });
  writeFileSync(join(stage, 'package', 'bin', 'opencode'), executableContent);
  const file = join(scratch, 'opencode.tgz');
  await tar.c({ gzip: true, file, cwd: stage }, ['package']);
  return file;
}

describe('parseOpencodeVersion', () => {
  test('extracts a bare semver', () => {
    expect(parseOpencodeVersion('1.17.11\n')).toBe('1.17.11');
  });

  test('extracts a prerelease semver from surrounding text', () => {
    expect(parseOpencodeVersion('opencode 1.2.3-beta.1 (bun)')).toBe('1.2.3-beta.1');
  });

  test('returns null when no version is present', () => {
    expect(parseOpencodeVersion('command not found')).toBeNull();
  });
});

describe('opencodePlatformPackage', () => {
  test('maps darwin/arm64', () => {
    expect(opencodePlatformPackage('darwin', 'arm64')).toBe('opencode-darwin-arm64');
  });

  test('maps linux/x64 with musl suffix', () => {
    expect(opencodePlatformPackage('linux', 'x64', true)).toBe('opencode-linux-x64-musl');
  });

  test('maps linux/arm64 glibc', () => {
    expect(opencodePlatformPackage('linux', 'arm64', false)).toBe('opencode-linux-arm64');
  });

  test('throws for unsupported platforms', () => {
    expect(() => opencodePlatformPackage('win32', 'x64')).toThrow(/KORTIX_OPENCODE_BIN/);
    expect(() => opencodePlatformPackage('linux', 'ia32')).toThrow(/KORTIX_OPENCODE_BIN/);
  });
});

describe('ensureOpencodeBin', () => {
  test('KORTIX_OPENCODE_BIN overrides everything', async () => {
    process.env.KORTIX_OPENCODE_BIN = '/custom/opencode';

    const resolved = await ensureOpencodeBin({
      version: '9.9.9',
      fetchImpl: neverFetch,
      probePathVersion: noPathBinary,
    });

    expect(resolved).toEqual({ bin: '/custom/opencode', source: 'env', version: null });
  });

  test('uses an already-managed binary without touching network or PATH', async () => {
    const managed = managedOpencodePath('9.9.9');
    mkdirSync(join(process.env.KORTIX_OPENCODE_DIR!, '9.9.9'), { recursive: true });
    writeFileSync(managed, '#!/bin/sh\n');

    const resolved = await ensureOpencodeBin({
      version: '9.9.9',
      fetchImpl: neverFetch,
      probePathVersion: () => {
        throw new Error('probe must not run on a cache hit');
      },
    });

    expect(resolved).toEqual({ bin: managed, source: 'managed', version: '9.9.9' });
  });

  test('uses PATH opencode when its version matches exactly', async () => {
    const resolved = await ensureOpencodeBin({
      version: '9.9.9',
      fetchImpl: neverFetch,
      probePathVersion: () => '9.9.9',
    });

    expect(resolved).toEqual({ bin: 'opencode', source: 'path', version: '9.9.9' });
  });

  test('downloads, caches, and marks the binary executable', async () => {
    const tarball = await makeTarball('#!/bin/sh\necho fake-opencode\n');
    let requestedUrl = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(Bun.file(tarball));
    }) as typeof fetch;

    const resolved = await ensureOpencodeBin({
      version: '9.9.9',
      fetchImpl,
      probePathVersion: noPathBinary,
    });

    const managed = managedOpencodePath('9.9.9');
    expect(resolved).toEqual({ bin: managed, source: 'downloaded', version: '9.9.9' });
    expect(requestedUrl).toContain('https://registry.npmjs.org/');
    expect(requestedUrl).toContain('9.9.9.tgz');
    expect(existsSync(managed)).toBe(true);
    expect(statSync(managed).mode & 0o111).not.toBe(0);

    const second = await ensureOpencodeBin({
      version: '9.9.9',
      fetchImpl: neverFetch,
      probePathVersion: noPathBinary,
    });
    expect(second.source).toBe('managed');
  });

  test('falls back to a mismatched PATH binary when the download fails', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;

    const resolved = await ensureOpencodeBin({
      version: '9.9.9',
      fetchImpl,
      probePathVersion: () => '1.0.0',
    });

    expect(resolved).toEqual({ bin: 'opencode', source: 'path-fallback', version: '1.0.0' });
  });

  test('fails with install guidance when download fails and PATH has nothing', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;

    await expect(
      ensureOpencodeBin({ version: '9.9.9', fetchImpl, probePathVersion: noPathBinary }),
    ).rejects.toThrow(/KORTIX_OPENCODE_BIN/);
  });
});
