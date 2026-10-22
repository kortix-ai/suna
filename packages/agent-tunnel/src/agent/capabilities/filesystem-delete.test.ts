import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemCapability } from './filesystem';
import type { TunnelConfig } from '../config';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tunnel-delete-'));
  roots.push(root);
  const config: TunnelConfig = {
    token: '', tunnelId: '', apiUrl: 'http://localhost', wsPath: '/ws',
    maxFileSize: 1024, allowedPaths: [root], blockedPaths: [],
    allowedCommands: [], blockedCommands: [], workingDir: root,
    shellTimeout: 1000, shellMaxTimeout: 1000, shellMaxOutputSize: 1024, shellEnvPassthrough: [],
  };
  const handler = createFilesystemCapability(config).methods.get('fs.delete');
  if (!handler) throw new Error('fs.delete handler missing');
  const permission = { permissionId: 'test', capability: 'filesystem', scope: { paths: [root], operations: ['delete'] } };
  return { root, config, permission, deletePath: (path: string) => handler({ path, __permission: permission }) };
}

test('deletes an empty allowed directory and rejects a second deletion', async () => {
  const { root, deletePath } = await fixture();
  const path = join(root, 'empty');
  await mkdir(path);
  expect(await deletePath(path)).toEqual({ deleted: true, path });
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(deletePath(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('deletes an allowed file', async () => {
  const { root, deletePath } = await fixture();
  const path = join(root, 'file');
  await writeFile(path, 'fixture');
  expect(await deletePath(path)).toEqual({ deleted: true, path });
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects a non-empty directory without modifying its contents', async () => {
  const { root, deletePath } = await fixture();
  const path = join(root, 'non-empty');
  await mkdir(path);
  const child = join(path, 'keep');
  await writeFile(child, 'preserve');
  await expect(deletePath(path)).rejects.toThrow();
  expect((await lstat(path)).isDirectory()).toBe(true);
  expect(await readFile(child, 'utf8')).toBe('preserve');
});

test('rejects a missing path', async () => {
  const { root, deletePath } = await fixture();
  await expect(deletePath(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('preserves directories outside the local ceiling and permission scope', async () => {
  const fixtureA = await fixture();
  const fixtureB = await fixture();
  await expect(fixtureA.deletePath(fixtureB.root)).rejects.toThrow('outside allowed directories');
  expect((await lstat(fixtureB.root)).isDirectory()).toBe(true);
  const sibling = join(fixtureA.root, 'sibling');
  await mkdir(sibling);
  fixtureA.permission.scope.paths = [join(fixtureA.root, 'approved')];
  await expect(fixtureA.deletePath(sibling)).rejects.toThrow('outside allowed directories');
  expect((await lstat(sibling)).isDirectory()).toBe(true);
});

test('preserves blocked directories and directories without delete permission', async () => {
  const { root, config, permission, deletePath } = await fixture();
  const path = join(root, 'keep');
  await mkdir(path);
  config.blockedPaths.push(path);
  await expect(deletePath(path)).rejects.toThrow('blocked path');
  config.blockedPaths = [];
  permission.scope.operations = ['read'];
  await expect(deletePath(path)).rejects.toThrow('operation "delete" is not allowed');
  expect((await lstat(path)).isDirectory()).toBe(true);
});

for (const kind of ['file', 'directory', 'missing']) {
  test(`deletes an allowed ${kind} symlink without deleting its target`, async () => {
    const { root, deletePath } = await fixture();
    const target = join(root, 'target');
    if (kind === 'file') await writeFile(target, 'preserve');
    if (kind === 'directory') await mkdir(target);
    const path = join(root, 'link');
    await symlink(target, path);
    expect(await deletePath(path)).toEqual({ deleted: true, path });
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    if (kind === 'file') expect(await readFile(target, 'utf8')).toBe('preserve');
    if (kind === 'directory') expect((await lstat(target)).isDirectory()).toBe(true);
    if (kind === 'missing') await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
}

test('rejects an outside-target symlink and preserves both link and target', async () => {
  const { root, deletePath } = await fixture();
  const outside = await fixture();
  const path = join(root, 'escape');
  await symlink(outside.root, path);
  await expect(deletePath(path)).rejects.toThrow('outside allowed directories');
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect((await lstat(outside.root)).isDirectory()).toBe(true);
});
