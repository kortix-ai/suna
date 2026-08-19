import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TunnelConfig } from '../config';
import { createDesktopCapability } from './desktop';
import { createEnabledCapabilityRegistry } from './enabled-registry';
import { CuaDriver } from './desktop/cua-driver';
import { createFilesystemCapability } from './filesystem';
import { createShellCapability } from './shell';

let root = '';
let outside = '';

function config(): TunnelConfig {
  return {
    token: 'kortix_tnl_test',
    tunnelId: '00000000-0000-4000-8000-000000000000',
    apiUrl: 'http://127.0.0.1:8008/v1/tunnel',
    wsPath: '/ws',
    maxFileSize: 1024,
    allowedPaths: [root],
    allowedCommands: [],
    blockedCommands: [],
    blockedPaths: [],
    workingDir: root,
    shellTimeout: 1_000,
    shellMaxTimeout: 2_000,
    shellMaxOutputSize: 1024,
    shellEnvPassthrough: ['PATH'],
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-tunnel-allowed-'));
  outside = await mkdtemp(join(tmpdir(), 'agent-tunnel-outside-'));
  await writeFile(join(root, 'allowed.txt'), 'allowed');
  await writeFile(join(outside, 'secret.txt'), 'secret');
});

afterEach(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

describe('local capability permission enforcement', () => {
  test('a zero-capability approval registers no local RPC handlers', () => {
    const registry = createEnabledCapabilityRegistry({
      ...config(),
      enabledCapabilities: [],
    });
    expect(registry.getCapabilityNames()).toEqual([]);
    expect(registry.getHandler('fs.read')).toBeNull();
    expect(registry.getHandler('shell.exec')).toBeNull();
    expect(registry.getHandler('desktop.cua.call')).toBeNull();
  });

  test('desktop is not advertised when no trusted local driver exists', () => {
    const registry = createEnabledCapabilityRegistry(
      { ...config(), enabledCapabilities: ['desktop'] },
      () => null,
    );
    expect(registry.getCapabilityNames()).toEqual([]);
    expect(registry.getHandler('desktop.cua.get_screen_size')).toBeNull();
  });

  test('desktop is advertised when a trusted local driver exists', () => {
    const registry = createEnabledCapabilityRegistry(
      { ...config(), enabledCapabilities: ['desktop'] },
      () => '/trusted/cua-driver',
    );
    expect(registry.getCapabilityNames()).toEqual(['desktop']);
    expect(registry.getHandler('desktop.cua.get_screen_size')).not.toBeNull();
  });
  test('a permission scope cannot widen the local filesystem ceiling', async () => {
    const handler = createFilesystemCapability(config()).methods.get('fs.read')!;
    await expect(
      handler({
        path: join(outside, 'secret.txt'),
        __permission: {
          permissionId: 'permission-1',
          capability: 'filesystem',
          scope: { paths: [outside], operations: ['read'] },
        },
      }),
    ).rejects.toThrow('outside allowed directories');
  });

  test('filesystem operations are checked again on the machine', async () => {
    const handler = createFilesystemCapability(config()).methods.get('fs.read')!;
    await expect(
      handler({
        path: join(root, 'allowed.txt'),
        __permission: {
          permissionId: 'permission-1',
          capability: 'filesystem',
          scope: { operations: ['write'] },
        },
      }),
    ).rejects.toThrow('operation "read" is not allowed');
  });

  test('shell command and working-directory scopes are checked on the machine', async () => {
    const handler = createShellCapability(config()).methods.get('shell.exec')!;
    await expect(
      handler({
        command: 'node',
        args: ['--version'],
        cwd: outside,
        __permission: {
          permissionId: 'permission-1',
          capability: 'shell',
          scope: { commands: ['node'], workingDir: root },
        },
      }),
    ).rejects.toThrow('outside allowed directories');
  });

  test('disjoint local and permission command allowlists fail closed', async () => {
    const handler = createShellCapability({ ...config(), allowedCommands: ['node'] }).methods.get(
      'shell.exec',
    )!;
    await expect(
      handler({
        command: 'sh',
        args: ['-c', 'echo must-not-run'],
        __permission: {
          permissionId: 'permission-1',
          capability: 'shell',
          scope: { commands: ['sh'] },
        },
      }),
    ).rejects.toThrow('not in the allowed commands list');
  });

  test('desktop feature scopes deny before invoking cua-driver', async () => {
    const handler = createDesktopCapability().methods.get('desktop.cua.click')!;
    await expect(
      handler({
        x: 10,
        y: 10,
        __permission: {
          permissionId: 'permission-1',
          capability: 'desktop',
          scope: { features: ['screenshot'] },
        },
      }),
    ).rejects.toThrow('desktop feature "mouse" is not allowed');
  });

  test('remote desktop calls cannot trigger mutable installer or update tools', async () => {
    const capability = createDesktopCapability();
    expect(capability.methods.has('desktop.cua.check_for_update')).toBe(false);
    expect(capability.methods.has('desktop.cua.install_ffmpeg')).toBe(false);

    const call = capability.methods.get('desktop.cua.call')!;
    await expect(
      call({
        tool: 'check_for_update',
        __permission: {
          permissionId: 'permission-1',
          capability: 'desktop',
          scope: { features: ['computer_use'] },
        },
      }),
    ).rejects.toThrow('local-only');
  });

  test('cua-driver receives neither tunnel environment secrets nor internal permission data', async () => {
    if (process.platform === 'win32') return;
    const binary = join(root, 'fake-cua-driver');
    await writeFile(
      binary,
      [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify({',
        '  token: process.env.TUNNEL_TOKEN ?? null,',
        '  args: process.argv.slice(2),',
        '}));',
      ].join('\n'),
    );
    await chmod(binary, 0o700);
    const previousBinary = process.env.CUA_DRIVER_BIN;
    const previousToken = process.env.TUNNEL_TOKEN;
    process.env.CUA_DRIVER_BIN = binary;
    process.env.TUNNEL_TOKEN = 'must-not-leak';

    try {
      const result = (await new CuaDriver().call('click', {
        x: 1,
        __permission: { permissionId: 'private-permission-id' },
      })) as { token: string | null; args: string[] };
      expect(result.token).toBeNull();
      expect(result.args.join(' ')).not.toContain('private-permission-id');
    } finally {
      if (previousBinary === undefined) delete process.env.CUA_DRIVER_BIN;
      else process.env.CUA_DRIVER_BIN = previousBinary;
      if (previousToken === undefined) delete process.env.TUNNEL_TOKEN;
      else process.env.TUNNEL_TOKEN = previousToken;
    }
  });
});
