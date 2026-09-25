/**
 * Inside a managed sandbox the PLATFORM owns the binaries, not the CLI.
 *
 * `KORTIX_SUPERVISED=1` is exported unconditionally by apps/sandbox/entrypoint.sh
 * before it execs the daemon, and the daemon's PTY inherits `process.env`
 * (routes/pty.ts `env = { ...process.env, … }`). So every shell a human opens in
 * the Session terminal carries it, and it is the one reliable "you are inside a
 * box we manage" signal available to a compiled CLI.
 *
 * Two self-update paths must die on that signal:
 *
 *  1. `kortix update` / the bare-`kortix` "Update to vX now?" prompt. Both run
 *     kortix.com/install, which installs into ~/.local/bin — FIRST on the image
 *     PATH — while runtime-assets.ts only ever converges /usr/local/bin/kortix.
 *     One accepted prompt therefore leaves a PUBLIC CLI permanently shadowing
 *     the platform's, pointed at the public API, that the platform cannot heal.
 *     The prompt defaults to YES and the Session terminal is a real PTY, so the
 *     TTY check protects nobody.
 *
 *  2. `opencode-bin.ts` downloading ~40 MB from registry.npmjs.org. That one has
 *     no TTY gate and no prompt at all.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runUpdate } from '../commands/update.ts';
import { ensureOpencodeBin } from '../opencode-bin.ts';
import { isSupervised } from '../supervised.ts';
import { getUpdateNotice, resolveUpdateStatus } from '../update-check.ts';

let dir = '';
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
let out = '';

function captureOutput(): void {
  out = '';
  const sink = (chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
}

function releaseOutput(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-supervised-'));
  process.env.KORTIX_CONFIG_FILE = join(dir, 'config.json');
  process.env.KORTIX_OPENCODE_DIR = join(dir, 'managed');
  delete process.env.KORTIX_NO_UPDATE_CHECK;
  delete process.env.KORTIX_SKIP_UPDATE_CHECK;
  delete process.env.KORTIX_OPENCODE_BIN;
  delete process.env.CI;
  // The update notifier bails on a non-TTY stdout, which is what `bun test`
  // gives us. Force it on: the point of these tests is that the supervised
  // gate holds on a REAL terminal, which the Session PTY is.
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ tag_name: 'v9.9.9' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  releaseOutput();
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

describe('isSupervised', () => {
  test('is true only for the exact signal the entrypoint exports', () => {
    delete process.env.KORTIX_SUPERVISED;
    expect(isSupervised()).toBe(false);
    process.env.KORTIX_SUPERVISED = '1';
    expect(isSupervised()).toBe(true);
    process.env.KORTIX_SUPERVISED = ' 1 ';
    expect(isSupervised()).toBe(true);
    process.env.KORTIX_SUPERVISED = '0';
    expect(isSupervised()).toBe(false);
    process.env.KORTIX_SUPERVISED = '';
    expect(isSupervised()).toBe(false);
  });
});

describe('the self-update prompt inside a managed sandbox', () => {
  test('resolveUpdateStatus is null on a TTY when supervised, so no box and no prompt', async () => {
    expect(await resolveUpdateStatus('0.10.15', { allowFetch: true })).not.toBeNull();
    process.env.KORTIX_SUPERVISED = '1';
    expect(await resolveUpdateStatus('0.10.15', { allowFetch: true })).toBeNull();
  });

  test('getUpdateNotice renders nothing when supervised — box and line alike', async () => {
    process.env.KORTIX_SUPERVISED = '1';
    expect(await getUpdateNotice('0.10.15', { allowFetch: true, style: 'box' })).toBeNull();
    expect(await getUpdateNotice('0.10.15', { allowFetch: true, style: 'line' })).toBeNull();
  });
});

describe('kortix update inside a managed sandbox', () => {
  test('refuses, exits non-zero, and never reaches the public installer', async () => {
    process.env.KORTIX_SUPERVISED = '1';
    captureOutput();
    const code = await runUpdate([]);
    releaseOutput();
    expect(code).not.toBe(0);
    // It must say WHY, and it must not have printed the curl|bash it would
    // otherwise be running.
    expect(out).toContain('platform');
    expect(out).not.toContain('curl -fsSL');
  });

  test('--help still works when supervised — reading is never blocked', async () => {
    process.env.KORTIX_SUPERVISED = '1';
    captureOutput();
    const code = await runUpdate(['--help']);
    releaseOutput();
    expect(code).toBe(0);
    expect(out).toContain('Usage: kortix update');
  });
});

describe('ensureOpencodeBin inside a managed sandbox', () => {
  const neverFetch: typeof fetch = (() => {
    throw new Error('unexpected network call');
  }) as unknown as typeof fetch;

  test('never downloads from the public registry; falls back to the PATH binary', async () => {
    process.env.KORTIX_SUPERVISED = '1';
    const res = await ensureOpencodeBin({
      version: '1.18.23',
      fetchImpl: neverFetch,
      probePathVersion: () => '1.18.19',
    });
    expect(res).toEqual({ bin: 'opencode', source: 'path-fallback', version: '1.18.19' });
  });

  test('never downloads when there is no PATH binary either — it throws instead', async () => {
    process.env.KORTIX_SUPERVISED = '1';
    await expect(
      ensureOpencodeBin({
        version: '1.18.23',
        fetchImpl: neverFetch,
        probePathVersion: () => null,
      }),
    ).rejects.toThrow(/platform/i);
  });

  test('an exact PATH match is still used, with no download', async () => {
    process.env.KORTIX_SUPERVISED = '1';
    const res = await ensureOpencodeBin({
      version: '1.18.23',
      fetchImpl: neverFetch,
      probePathVersion: () => '1.18.23',
    });
    expect(res).toEqual({ bin: 'opencode', source: 'path', version: '1.18.23' });
  });

  test('an already-cached managed binary is still used, with no download', async () => {
    process.env.KORTIX_SUPERVISED = '1';
    const managed = join(dir, 'managed', '1.18.23');
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, 'opencode'), '#!/bin/sh\n');
    const res = await ensureOpencodeBin({
      version: '1.18.23',
      fetchImpl: neverFetch,
      probePathVersion: () => null,
    });
    expect(res.source).toBe('managed');
  });

  test('KORTIX_OPENCODE_BIN still wins — an explicit operator override is not a download', async () => {
    process.env.KORTIX_SUPERVISED = '1';
    process.env.KORTIX_OPENCODE_BIN = '/opt/kortix/opencode.current';
    const res = await ensureOpencodeBin({ version: '1.18.23', fetchImpl: neverFetch });
    expect(res).toEqual({ bin: '/opt/kortix/opencode.current', source: 'env', version: null });
  });
});
