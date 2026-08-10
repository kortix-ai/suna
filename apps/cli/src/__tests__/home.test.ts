import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHome } from '../commands/home.ts';

const savedEnv: Record<string, string | undefined> = {};
let scratch: string;
const ttyDescriptors: Array<{
  stream: NodeJS.ReadStream | NodeJS.WriteStream;
  descriptor: PropertyDescriptor | undefined;
}> = [];

function setTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean | undefined) {
  ttyDescriptors.push({ stream, descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY') });
  Object.defineProperty(stream, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  for (const key of ['KORTIX_AUTH_FILE', 'KORTIX_CONFIG_FILE', 'KORTIX_CLI_TOKEN', 'KORTIX_API_URL']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  scratch = mkdtempSync(join(tmpdir(), 'home-test-'));
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (ttyDescriptors.length > 0) {
    const { stream, descriptor } = ttyDescriptors.pop()!;
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as unknown as Record<string, unknown>).isTTY;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('runHome gating', () => {
  test('falls back to the landing screen on a non-TTY stdin', async () => {
    setTTY(process.stdin, false);
    setTTY(process.stdout, true);

    expect(await runHome()).toBe('landing');
  });

  test('falls back to the landing screen on a non-TTY stdout', async () => {
    setTTY(process.stdin, true);
    setTTY(process.stdout, false);

    expect(await runHome()).toBe('landing');
  });

  test('falls back to the landing screen when not logged in', async () => {
    setTTY(process.stdin, true);
    setTTY(process.stdout, true);
    process.env.KORTIX_AUTH_FILE = join(scratch, 'missing-auth.json');
    process.env.KORTIX_CONFIG_FILE = join(scratch, 'missing-config.json');

    expect(await runHome()).toBe('landing');
  });
});
