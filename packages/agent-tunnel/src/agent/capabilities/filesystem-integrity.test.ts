import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemCapability } from './filesystem';
import type { TunnelConfig } from '../config';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tunnel-integrity-'));
  roots.push(root);
  const config: TunnelConfig = {
    token: '', tunnelId: '', apiUrl: 'http://localhost', wsPath: '/ws',
    maxFileSize: 1024 * 1024, allowedPaths: [root], blockedPaths: [],
    allowedCommands: [], blockedCommands: [], workingDir: root,
    shellTimeout: 1000, shellMaxTimeout: 1000, shellMaxOutputSize: 1024, shellEnvPassthrough: [],
  };
  return { path: join(root, 'artifact.xlsx'), write: createFilesystemCapability(config).methods.get('fs.write')!,
    __permission: { permissionId: 'test', capability: 'filesystem', scope: { paths: [root], operations: ['write'] } } };
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('binary write returns the persisted SHA-256 and preserves every byte', async () => {
  const { write, ...params } = await fixture();
  const bytes = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256));
  const result = await write({ ...params, content: bytes.toString('base64'), encoding: 'base64', sha256: sha256(bytes) });
  expect(result).toMatchObject({ size: bytes.length, sha256: sha256(bytes) });
  expect(await readFile(params.path)).toEqual(bytes);
});

test('same-length corruption fails before overwriting an existing destination', async () => {
  const { write, ...params } = await fixture();
  await writeFile(params.path, 'preserve me');
  const source = Buffer.from('PK valid-looking archive');
  const corrupt = Buffer.from(source); corrupt[10] ^= 1;
  await expect(write({ ...params, content: corrupt.toString('base64'), encoding: 'base64', sha256: sha256(source) })).rejects.toThrow('SHA-256 mismatch');
  expect(await readFile(params.path, 'utf8')).toBe('preserve me');
});

test('malformed base64 fails before writing', async () => {
  const { write, ...params } = await fixture();
  await expect(write({ ...params, content: 'aGVsbG8=!', encoding: 'base64' })).rejects.toThrow('base64');
  expect(await Bun.file(params.path).exists()).toBe(false);
});
