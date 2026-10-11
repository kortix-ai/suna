import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectedAgentPaths, type TunnelConfig } from '../config';
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
    expect(registry.getHandler('desktop.cua.call')).not.toBeNull();
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

  test('a file grant cannot rewrite the agent home (access.json, desktop-app.json)', async () => {
    const home = join(root, 'agent-tunnel', 'abcd1234');
    const write = createFilesystemCapability({
      ...config(),
      blockedPaths: protectedAgentPaths(home),
    }).methods.get('fs.write')!;
    const permission = {
      permissionId: 'permission-1',
      capability: 'filesystem',
      scope: { operations: ['write'] },
    };
    for (const target of [join(home, 'access.json'), join(home, 'desktop-app.json'), join(root, 'agent-tunnel', 'other', 'access.json')]) {
      await expect(
        write({ path: target, content: '{"mode":"always"}', __permission: permission }),
      ).rejects.toThrow('blocked path');
    }
    await write({ path: join(root, 'notes.txt'), content: 'ok', __permission: permission });
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

  test('a desktop grant allows every driver tool, and a legacy feature scope no longer narrows it', async () => {
    const binary = join(root, 'fake-call-driver');
    const log = join(root, 'call-args.jsonl');
    await writeFile(binary, [
      '#!/usr/bin/env node',
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2, 4)) + '\\n');`,
      `process.stdout.write('{"ok":true}');`,
    ].join('\n'));
    await chmod(binary, 0o700);
    const previousBinary = process.env.CUA_DRIVER_BIN;
    process.env.CUA_DRIVER_BIN = binary;
    try {
      const call = createDesktopCapability().methods.get('desktop.cua.call')!;
      const __permission = { permissionId: 'p', capability: 'desktop', scope: { features: ['screenshot'] } };
      // health_report was never in Kortix's tool list; the driver owns that list.
      expect(await call({ tool: 'health_report', args: {}, __permission })).toEqual({ ok: true });
      await expect(call({ tool: 'install_ffmpeg', __permission })).rejects.toThrow('local-only');
      await expect(call({ tool: 'click', __permission: { ...__permission, capability: 'shell' } }))
        .rejects.toThrow('desktop permission required');
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.at(-1)).toEqual(['call', 'health_report']);
    } finally {
      if (previousBinary === undefined) delete process.env.CUA_DRIVER_BIN;
      else process.env.CUA_DRIVER_BIN = previousBinary;
    }
  });

  test('a failed call reports missing macOS grants as computer_desktop_permission_missing (-32013)', async () => {
    const binary = join(root, 'fake-untrusted-driver');
    await writeFile(binary, [
      '#!/usr/bin/env node',
      'const [command, tool] = process.argv.slice(2);',
      `if (command === 'call' && tool === 'check_permissions') process.stdout.write('{"accessibility":false,"screen_recording":false}');`,
      `else if (command === 'call') { process.stderr.write('AX is not trusted'); process.exitCode = 1; }`,
      `else process.stdout.write('running');`,
    ].join('\n'));
    await chmod(binary, 0o700);
    const previousBinary = process.env.CUA_DRIVER_BIN;
    process.env.CUA_DRIVER_BIN = binary;
    let restarts = 0;
    try {
      const call = createDesktopCapability({ onPermissionMissing: () => restarts++ }).methods.get('desktop.cua.call')!;
      const error = await call({ tool: 'click', args: { pid: 1 }, __permission: { permissionId: 'p', capability: 'desktop', scope: {} } })
        .catch((err: unknown) => err as Error & { code?: number });
      expect((error as Error).message).toBe(
        'computer_desktop_permission_missing: macOS has not given CuaDriver Accessibility and Screen Recording on this computer.',
      );
      expect((error as { code?: number }).code).toBe(-32013);
      expect(restarts).toBe(1);
    } finally {
      if (previousBinary === undefined) delete process.env.CUA_DRIVER_BIN;
      else process.env.CUA_DRIVER_BIN = previousBinary;
    }
  });

  test('desktop discovery dispatches to driver metadata commands and preserves unsupported output', async () => {
    const binary = join(root, 'fake-discovery-driver');
    const log = join(root, 'discovery-args.jsonl');
    await writeFile(binary, [
      '#!/usr/bin/env node',
      `const fs = require('node:fs');`,
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      'const [command, tool] = process.argv.slice(2);',
      `if (command === 'list-tools') process.stdout.write('double_click\\n');`,
      `else if (command === 'describe' && tool === 'double_click') process.stdout.write('Double click coordinates\\n');`,
      `else if (command === 'describe') { process.stderr.write('Unsupported tool: ' + tool); process.exitCode = 2; }`,
      `else { process.stderr.write('Unexpected command'); process.exitCode = 3; }`,
    ].join('\n'));
    await chmod(binary, 0o700);
    const previousBinary = process.env.CUA_DRIVER_BIN;
    process.env.CUA_DRIVER_BIN = binary;
    try {
      const capability = createDesktopCapability();
      const list = capability.methods.get('desktop.cua.list_tools');
      const describeTool = capability.methods.get('desktop.cua.describe');
      if (!list || !describeTool) throw new Error('Discovery handlers missing');
      const __permission = {
        permissionId: 'permission-discovery', capability: 'desktop',
        scope: { features: ['computer_use'] },
      };
      await expect(list({})).rejects.toThrow('desktop permission required');
      expect(await list({ __permission })).toEqual({ tools: 'double_click' });
      expect(await describeTool({ tool: 'double_click', __permission }))
        .toEqual({ description: 'Double click coordinates' });
      await expect(describeTool({ tool: 'unsupported_tool', __permission }))
        .rejects.toThrow('Unsupported tool: unsupported_tool');
      expect((await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
        .toEqual([['list-tools'], ['describe', 'double_click'], ['describe', 'unsupported_tool']]);
    } finally {
      if (previousBinary === undefined) delete process.env.CUA_DRIVER_BIN;
      else process.env.CUA_DRIVER_BIN = previousBinary;
    }
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
