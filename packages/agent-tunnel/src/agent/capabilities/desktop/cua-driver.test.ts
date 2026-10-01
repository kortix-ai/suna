import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { bundledCuaDriverPath, CuaDriver } from './cua-driver';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cua-driver-test-'));
  dirs.push(dir);
  return dir;
}

/** A stand-in driver: logs each invocation, and `serve` creates its socket. */
function fakeDriver(dir: string): { binary: string; log: string } {
  const binary = join(dir, 'cua-driver');
  const log = join(dir, 'calls.log');
  writeFileSync(
    binary,
    `#!/bin/sh
echo "$* | embedded=$CUA_DRIVER_EMBEDDED telemetry=$CUA_DRIVER_RS_TELEMETRY_ENABLED host=$CUA_DRIVER_HOST_BUNDLE_ID" >> "${log}"
case "$1" in
  serve)
    while [ "$#" -gt 0 ]; do [ "$1" = "--socket" ] && touch "$2"; shift; done
    sleep 30 ;;
  status)
    # Like the real driver: running only while a daemon listens on the socket.
    if [ "$2" = "--socket" ] && [ ! -e "$3" ]; then echo "not running"; else echo "running"; fi ;;
  call) echo '{"ok":true}' ;;
esac
`,
  );
  chmodSync(binary, 0o755);
  return { binary, log };
}

describe('bundledCuaDriverPath', () => {
  test('finds the driver the desktop app ships beside the agent bundle', () => {
    const resources = join(tempDir(), 'Kortix.app', 'Contents', 'Resources');
    mkdirSync(join(resources, 'agent-tunnel'), { recursive: true });
    mkdirSync(join(resources, 'cua-driver'), { recursive: true });
    const agent = join(resources, 'agent-tunnel', 'agent-cli.js');
    writeFileSync(agent, '');
    expect(bundledCuaDriverPath(agent)).toBeNull();
    writeFileSync(join(resources, 'cua-driver', 'cua-driver'), '');
    expect(bundledCuaDriverPath(agent)).toBe(join(resources, 'cua-driver', 'cua-driver'));
  });

  test('an npm install has no bundled driver', () => {
    expect(bundledCuaDriverPath('/usr/local/lib/node_modules/@kortix/agent-tunnel/dist/agent-cli.js')).toBeNull();
    expect(bundledCuaDriverPath(undefined)).toBeNull();
  });
});

describe('embedded driver', () => {
  test('starts its own private daemon as a child, never through LaunchServices, and calls through it', async () => {
    const dir = tempDir();
    const { binary, log } = fakeDriver(dir);
    const socketPath = join(dir, 'cua.sock');
    const driver = new CuaDriver({ binary, embedded: true, socketPath, hostBundleId: 'com.kortix.desktop' });
    try {
      expect(await driver.call('click', { pid: 1 })).toEqual({ ok: true });
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      const serve = calls.find((line) => line.startsWith('serve '));
      expect(serve).toBe(
        `serve --embedded --no-permissions-gate --socket ${socketPath} | embedded=1 telemetry=0 host=com.kortix.desktop`,
      );
      expect(calls.at(-1)).toBe(
        `call click {"pid":1} --socket ${socketPath} | embedded=1 telemetry=0 host=com.kortix.desktop`,
      );
    } finally {
      driver.stop();
    }
  });

  test('a separately installed driver keeps its standalone mode, without telemetry', async () => {
    const dir = tempDir();
    const { binary, log } = fakeDriver(dir);
    const driver = new CuaDriver({ binary });
    expect(await driver.status()).toBe('running');
    expect(readFileSync(log, 'utf8').trim()).toBe('status | embedded= telemetry=0 host=');
  });
});
