import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCaptureBin, startCaptureSupervisor } from './capture-supervisor';

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-supervisor-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake recorder: appends a line per start (with its env) to starts.log, then runs `body`. */
function fakeBinary(dir: string, body: string) {
  const bin = join(dir, 'kortix-capture');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$1 $KORTIX_CAPTURE_DIR $AGENT_TUNNEL_HOME $KORTIX_CAPTURE_PARENT_PID" >> "${dir}/starts.log"\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
const starts = (dir: string) => {
  try {
    return readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const until = async (ok: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(25);
  expect(ok()).toBe(true);
};

describe('capture supervisor', () => {
  test('starts `record` with the capture dir and agent home, and logs its output', async () => {
    const dir = tmp();
    const home = join(dir, 'home');
    const bin = fakeBinary(dir, 'echo hello-from-recorder; sleep 30');
    const sup = startCaptureSupervisor({ bin, home });
    await until(() => starts(dir).length === 1);
    expect(starts(dir)[0]).toBe(`record ${join(home, 'capture')} ${home} ${process.pid}`);
    await until(() => existsSync(join(home, 'logs', 'capture.log')) && readFileSync(join(home, 'logs', 'capture.log'), 'utf8').includes('hello-from-recorder'));
    sup.stop();
  });

  test('KORTIX_CAPTURE_DIR overrides the default dir', async () => {
    const dir = tmp();
    const bin = fakeBinary(dir, 'sleep 30');
    const sup = startCaptureSupervisor({ bin, home: join(dir, 'h'), env: { ...process.env, KORTIX_CAPTURE_DIR: join(dir, 'custom') } });
    await until(() => starts(dir).length === 1);
    expect(starts(dir)[0]?.split(' ')[1]).toBe(join(dir, 'custom'));
    sup.stop();
  });

  test('restarts an exiting child with growing backoff', async () => {
    const dir = tmp();
    const bin = fakeBinary(dir, 'exit 1');
    const sup = startCaptureSupervisor({ bin, home: join(dir, 'h'), initialBackoffMs: 50, maxBackoffMs: 200 });
    await until(() => starts(dir).length >= 4);
    sup.stop();
  });

  test('stop forwards SIGTERM and prevents a restart', async () => {
    const dir = tmp();
    const bin = fakeBinary(dir, `trap 'echo term >> "${dir}/term.log"; exit 0' TERM\nwhile true; do sleep 0.1; done`);
    const sup = startCaptureSupervisor({ bin, home: join(dir, 'h'), initialBackoffMs: 50 });
    await until(() => starts(dir).length === 1);
    await Bun.sleep(150); // let the shell install its trap
    sup.stop();
    await until(() => existsSync(join(dir, 'term.log')));
    await Bun.sleep(300);
    expect(starts(dir).length).toBe(1);
  });

  test('a binary that cannot be executed never throws and keeps retrying', async () => {
    const dir = tmp();
    const sup = startCaptureSupervisor({ bin: join(dir, 'missing'), home: join(dir, 'h'), initialBackoffMs: 20, maxBackoffMs: 40 });
    await Bun.sleep(200);
    sup.stop();
  });

  test('resolveCaptureBin: env path, beside-the-bundle path, absent', () => {
    const dir = tmp();
    const bin = fakeBinary(dir, 'true');
    expect(resolveCaptureBin({ KORTIX_CAPTURE_BIN: bin }, join(dir, 'x', 'agent-cli.js'))).toBe(bin);
    expect(resolveCaptureBin({ KORTIX_CAPTURE_BIN: join(dir, 'nope') }, join(dir, 'x', 'agent-cli.js'))).toBeNull();
    const resources = tmp();
    const sibling = join(resources, 'capture');
    Bun.spawnSync(['mkdir', sibling]);
    const siblingBin = join(sibling, process.platform === 'win32' ? 'kortix-capture.exe' : 'kortix-capture');
    writeFileSync(siblingBin, '');
    expect(resolveCaptureBin({}, join(resources, 'agent-tunnel', 'agent-cli.js'))).toBe(join(resources, 'agent-tunnel', '..', 'capture', process.platform === 'win32' ? 'kortix-capture.exe' : 'kortix-capture'));
    expect(resolveCaptureBin({}, join(dir, 'agent-tunnel', 'agent-cli.js'))).toBeNull();
  });
});
