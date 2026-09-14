import type { WorkspaceCheckpoint, WorkspaceHistoryMove, WorkspaceHistoryReceipt } from '../../../packages/shared/src/workspace-history';
export type { WorkspaceCheckpoint, WorkspaceHistoryMove, WorkspaceHistoryReceipt } from '../../../packages/shared/src/workspace-history';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

type Entry = { kind: 'file'; blob: string; size: number; mode: number } | { kind: 'symlink'; target: string };
type Manifest = { version: 1; identity: string; files: Record<string, Entry> };
type Current = Entry | { kind: 'directory' | 'blocked' } | null;
export interface WorkspaceHistoryOptions {
  workspace: string;
  state: string;
  scope: string;
  maxFiles?: number;
  maxBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxHistoryBytes?: number;
  afterStaging?: (name: string) => void | Promise<void>;
  afterMutation?: (name: string) => void | Promise<void>;
}
export class WorkspaceHistoryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WorkspaceHistoryError'; }
}
const fail = (code: string, message: string): never => { throw new WorkspaceHistoryError(code, message); };
const same = (a: Current | undefined, b: Current | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const statOrNull = (target: string) => fs.lstat(target).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const parents = (name: string) => name.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
function validPath(name: string) {
  return !!name && Buffer.byteLength(name) <= 4096 && !name.includes('\\') && !name.includes('\0') &&
    name.split('/').every(part => !!part && part !== '.' && part !== '..' && part !== '.git');
}
function assertUuid(id: string) { if (typeof id !== 'string' || !UUID.test(id)) fail('invalid', 'invalid operation identity'); }
function assertHash(id: string) { if (typeof id !== 'string' || !HASH.test(id)) fail('invalid', 'invalid checkpoint identity'); }
async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicWrite(target: string, bytes: string | Buffer, mode = 0o600, staged?: { temporary: string; ready: () => void | Promise<void> }) {
  const temporary = staged?.temporary ?? path.join(path.dirname(target), `.kortix-history-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    created = true;
    try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
    finally { await handle.close(); }
    await staged?.ready();
    await fs.rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally { if (created) await fs.rm(temporary, { force: true }); }
}
async function writeRecord(target: string, value: unknown) {
  const body = JSON.stringify(value);
  await atomicWrite(target, JSON.stringify({ sha256: digest(body), value }));
}
async function readRecord<T>(target: string): Promise<T | null> {
  const file = await statOrNull(target);
  if (!file) return null;
  if (!file.isFile() || file.size > 8 * 1024 * 1024) fail('integrity', 'invalid history record');
  try {
    const record = JSON.parse(await fs.readFile(target, 'utf8'));
    if (digest(JSON.stringify(record.value)) !== record.sha256) fail('integrity', 'history record integrity failure');
    return record.value as T;
  } catch (error) {
    if (error instanceof WorkspaceHistoryError) throw error;
    return fail('integrity', 'history record integrity failure');
  }
}

export class WorkspaceHistory {
  private workspace = '';
  private state = '';
  private identity = '';
  private storedBytes = 0;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  constructor(private readonly options: WorkspaceHistoryOptions) {
    this.maxFiles = options.maxFiles ?? 10_000;
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.workspace = await fs.realpath(this.options.workspace);
    const state = path.resolve(this.options.state);
    if (inside(this.workspace, state) || inside(state, this.workspace)) fail('invalid', 'history state must be outside the workspace');
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    this.state = await fs.realpath(state);
    if (inside(this.workspace, this.state) || inside(this.state, this.workspace)) fail('invalid', 'history state must be outside the workspace');
    const lockPath = path.join(this.state, 'lock.sqlite');
    const lockFile = await statOrNull(lockPath);
    if (lockFile && !lockFile.isFile()) fail('integrity', 'invalid history lock file');
    const lock = new Database(lockPath);
    let locked = false;
    try {
      lock.exec('PRAGMA busy_timeout=0');
      try { lock.exec('BEGIN IMMEDIATE'); locked = true; }
      catch (error) {
        if ((error as { code?: string }).code === 'SQLITE_BUSY') fail('busy', 'workspace history is busy');
        throw error;
      }
      const workspaceStat = await fs.stat(this.workspace);
      const identityPath = path.join(this.state, 'identity.json');
      let identity = await readRecord<{ scope: string; workspace: string; generation: string; device: number; inode: number }>(identityPath);
      if (!identity) {
        identity = { scope: this.options.scope, workspace: this.workspace, generation: randomUUID(), device: workspaceStat.dev, inode: workspaceStat.ino };
        await writeRecord(identityPath, identity);
      }
      if (identity.scope !== this.options.scope || identity.workspace !== this.workspace || identity.device !== workspaceStat.dev || identity.inode !== workspaceStat.ino || !UUID.test(identity.generation)) {
        fail('identity', 'workspace history identity changed');
      }
      this.identity = digest(JSON.stringify(identity));
      for (const directory of ['blobs', 'snapshots', 'captures', 'operations']) {
        const target = path.join(this.state, directory);
        await fs.mkdir(target, { mode: 0o700, recursive: true });
        if ((await fs.lstat(target)).isSymbolicLink()) fail('integrity', 'history directory is a symlink');
      }
      this.storedBytes = 0;
      for (const directory of ['', 'blobs', 'snapshots', 'captures', 'operations']) {
        for (const name of await fs.readdir(path.join(this.state, directory))) {
          const entry = await fs.lstat(path.join(this.state, directory, name));
          if (entry.isFile()) this.storedBytes += entry.size;
        }
      }
      return await action();
    } finally {
      if (locked) lock.exec('ROLLBACK');
      lock.close();
    }
  }

  private assertStorage(additional: number) {
    if (this.storedBytes + additional > (this.options.maxHistoryBytes ?? 512 * 1024 * 1024)) fail('limit', 'history storage limit');
  }

  private async save(target: string, bytes: string | Buffer) {
    const prior = await statOrNull(target);
    if (prior && !prior.isFile()) fail('integrity', 'invalid history file');
    const growth = Buffer.byteLength(bytes) - (prior?.size ?? 0);
    this.assertStorage(growth);
    await atomicWrite(target, bytes);
    this.storedBytes += growth;
  }

  private async saveRecord(target: string, value: unknown) {
    await this.save(target, JSON.stringify({ sha256: digest(JSON.stringify(value)), value }));
  }

  private async current(name: string, saveBlob = false): Promise<Current> {
    for (const parent of parents(name)) {
      const found = await statOrNull(path.join(this.workspace, parent));
      if (!found) return null;
      if (!found.isDirectory()) return { kind: 'blocked' };
    }
    const target = path.join(this.workspace, name);
    const found = await statOrNull(target);
    if (!found) return null;
    if (found.isDirectory()) return { kind: 'directory' };
    if (found.isSymbolicLink()) return { kind: 'symlink', target: new TextDecoder('utf-8', { fatal: true }).decode(await fs.readlink(target, { encoding: 'buffer' })) };
    if (!found.isFile()) return fail('unsupported', `unsupported workspace file: ${name}`);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > this.maxBytes) fail('limit', `checkpoint file limit: ${name}`);
      const buffer = Buffer.allocUnsafe(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      const after = await handle.stat();
      const final = await fs.lstat(target);
      if (bytes.length > this.maxBytes) fail('limit', `checkpoint file limit: ${name}`);
      if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || final.ino !== after.ino || final.isSymbolicLink()) {
        fail('conflict', `workspace changed during checkpoint: ${name}`);
      }
      const blob = digest(bytes);
      if (saveBlob) {
        const location = path.join(this.state, 'blobs', blob);
        const stored = await statOrNull(location);
        if (!stored) await this.save(location, bytes);
        else if (!stored.isFile() || stored.size !== bytes.length || digest(await fs.readFile(location)) !== blob) fail('integrity', 'checkpoint blob integrity failure');
      }
      return { kind: 'file', blob, size: bytes.length, mode: after.mode & 0o777 };
    } finally { await handle.close(); }
  }

  private async paths(): Promise<string[]> {
    let names: string[];
    let entries = 0;
    const maxDepth = this.options.maxDepth ?? 64;
    if (await statOrNull(path.join(this.workspace, '.git'))) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
      const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--literal-pathspecs', '-C', this.workspace,
        'ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'], {
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
      });
      names = new TextDecoder('utf-8', { fatal: true }).decode(stdout).split('\0').filter(Boolean);
    } else {
      names = [];
      const walk = async (directory: string) => {
        for (const raw of await fs.readdir(path.join(this.workspace, directory), { encoding: 'buffer' })) {
          const name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
          if (name === '.git') continue;
          const relative = directory ? directory + '/' + name : name;
          if (++entries > (this.options.maxEntries ?? 50_000)) fail('limit', 'checkpoint entry count limit');
          if (relative.split('/').length > maxDepth) fail('limit', 'checkpoint depth limit');
          const found = await fs.lstat(path.join(this.workspace, relative));
          if (found.isDirectory()) await walk(relative);
          else names.push(relative);
          if (names.length > this.maxFiles) fail('limit', 'checkpoint file count limit');
        }
      };
      await walk('');
    }
    names = [...new Set(names)].sort();
    if (names.length > this.maxFiles) fail('limit', 'checkpoint file count limit');
    if (names.some(name => name.split('/').length > maxDepth)) fail('limit', 'checkpoint depth limit');
    if (!names.every(validPath)) fail('invalid', 'unsupported checkpoint path');
    return names;
  }

  private async readPending(): Promise<WorkspaceHistoryReceipt | null> {
    const pending = await readRecord<WorkspaceHistoryReceipt>(path.join(this.state, 'pending.json'));
    if (!pending) return null;
    assertUuid(pending.operationId);
    const complete = await readRecord<WorkspaceHistoryReceipt>(path.join(this.state, 'operations', pending.operationId + '.json'));
    if (complete) {
      if (complete.from !== pending.from || complete.to !== pending.to || complete.status !== 'complete') fail('integrity', 'history operation integrity failure');
      await fs.unlink(path.join(this.state, 'pending.json'));
      await syncDirectory(this.state);
      return null;
    }
    if (pending.status !== 'applying') fail('integrity', 'invalid pending history operation');
    return pending;
  }

  pending(): Promise<WorkspaceHistoryReceipt | null> { return this.exclusive(() => this.readPending()); }

  async capture(captureId: string): Promise<WorkspaceCheckpoint> {
    assertUuid(captureId);
    return this.exclusive(async () => {
      if (await this.readPending()) fail('pending', 'workspace history operation pending');
      const capturePath = path.join(this.state, 'captures', captureId + '.json');
      const prior = await readRecord<WorkspaceCheckpoint>(capturePath);
      if (prior) { await this.manifest(prior.snapshotId); return prior; }
      const files: Record<string, Entry> = Object.create(null);
      let bytes = 0;
      const names = await this.paths();
      for (const name of names) {
        const entry = await this.current(name, true);
        if (!entry) continue;
        if (entry.kind === 'directory' || entry.kind === 'blocked') fail('unsupported', `checkpoint cannot capture directory entry: ${name}`);
        files[name] = entry as Entry;
        bytes += entry.kind === 'file' ? entry.size : Buffer.byteLength((entry as { target: string }).target);
        if (bytes > this.maxBytes) fail('limit', 'checkpoint byte limit');
      }
      if (JSON.stringify(names) !== JSON.stringify(await this.paths())) fail('conflict', 'workspace paths changed during checkpoint');
      for (const name of names) {
        if (!same(await this.current(name), files[name])) fail('conflict', `workspace changed during checkpoint: ${name}`);
      }
      const manifest: Manifest = { version: 1, identity: this.identity, files };
      if (Buffer.byteLength(JSON.stringify(manifest)) > 7 * 1024 * 1024) fail('limit', 'checkpoint manifest size limit');
      const snapshotId = digest(JSON.stringify(manifest));
      await this.saveRecord(path.join(this.state, 'snapshots', snapshotId + '.json'), manifest);
      const result = { snapshotId, files: Object.keys(files).length, bytes };
      await this.saveRecord(capturePath, result);
      return result;
    });
  }

  private async manifest(id: string): Promise<Manifest> {
    assertHash(id);
    const saved = await readRecord<Manifest>(path.join(this.state, 'snapshots', id + '.json'));
    if (!saved) return fail('not_found', 'workspace checkpoint not found');
    if (saved.version !== 1 || saved.identity !== this.identity || !saved.files || typeof saved.files !== 'object' || Array.isArray(saved.files) || digest(JSON.stringify(saved)) !== id) {
      return fail('integrity', 'checkpoint integrity failure');
    }
    const entries = Object.entries(saved.files);
    if (entries.length > this.maxFiles) fail('limit', 'checkpoint file count limit');
    let bytes = 0;
    for (const [name, entry] of entries) {
      if (!validPath(name) || !entry || parents(name).some(parent => Object.hasOwn(saved.files, parent))) fail('integrity', 'invalid checkpoint path');
      if (entry.kind === 'file') {
        if (!HASH.test(entry.blob) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail('integrity', 'invalid checkpoint file');
        bytes += entry.size;
      } else if (entry.kind === 'symlink' && typeof entry.target === 'string' && entry.target.length > 0 && !entry.target.includes('\0')) bytes += Buffer.byteLength(entry.target);
      else fail('integrity', 'invalid checkpoint entry');
    }
    if (bytes > this.maxBytes) fail('limit', 'checkpoint byte limit');
    saved.files = Object.assign(Object.create(null), saved.files);
    return saved;
  }

  private async blob(entry: Entry): Promise<Buffer | null> {
    if (entry.kind !== 'file') return null;
    const target = path.join(this.state, 'blobs', entry.blob);
    const found = await statOrNull(target);
    if (!found?.isFile() || found.size !== entry.size) return fail('integrity', 'checkpoint blob integrity failure');
    const bytes = await fs.readFile(target);
    if (digest(bytes) !== entry.blob) return fail('integrity', 'checkpoint blob integrity failure');
    return bytes;
  }

  private async directoryMatches(name: string, source: Manifest): Promise<boolean> {
    const allowed = new Set(Object.keys(source.files).flatMap(file => [file, ...parents(file)]));
    const walk = async (directory: string): Promise<boolean> => {
      for (const child of await fs.readdir(path.join(this.workspace, directory))) {
        const file = directory + '/' + child;
        if (!allowed.has(file)) return false;
        const found = await fs.lstat(path.join(this.workspace, file));
        if (found.isDirectory() && !await walk(file)) return false;
      }
      return true;
    };
    return walk(name);
  }

  private async verify(name: string, source: Manifest, target: Manifest, resuming: boolean) {
    const current = await this.current(name);
    const from = source.files[name];
    const to = target.files[name];
    if (same(current, from) || (resuming && same(current, to))) return;
    if (resuming && !to && current?.kind === 'blocked' && parents(name).some(parent => target.files[parent])) return;
    if (resuming && !to && current?.kind === 'directory' && Object.keys(target.files).some(file => file.startsWith(name + '/')) && await this.directoryMatches(name, target)) return;
    if (resuming && current === null && from && (!to || from.kind !== to.kind)) return;
    if (!from && current?.kind === 'blocked' && parents(name).some(parent => source.files[parent] && !target.files[parent])) return;
    if (!from && current?.kind === 'directory' && Object.keys(source.files).some(file => file.startsWith(name + '/')) && await this.directoryMatches(name, source)) return;
    fail('conflict', `workspace rollback conflict: ${name}`);
  }

  private async ensureParents(name: string) {
    for (const parent of parents(name)) {
      const target = path.join(this.workspace, parent);
      const found = await statOrNull(target);
      if (!found) { await fs.mkdir(target); await syncDirectory(path.dirname(target)); }
      else if (!found.isDirectory()) fail('conflict', `workspace rollback parent conflict: ${parent}`);
    }
  }

  private async removeEmptyDirectories(name: string) {
    const target = path.join(this.workspace, name);
    const found = await statOrNull(target);
    if (!found?.isDirectory()) return;
    for (const child of await fs.readdir(target)) {
      if (!(await fs.lstat(path.join(target, child))).isDirectory()) fail('conflict', `workspace rollback directory conflict: ${name}`);
      await this.removeEmptyDirectories(name + '/' + child);
    }
    await fs.rmdir(target);
    await syncDirectory(path.dirname(target));
  }

  private temporary(name: string, operationId: string): string {
    return path.posix.join(path.posix.dirname(name), `.kortix-history-${operationId}-${digest(name)}.tmp`);
  }

  private async checkStaging(name: string, entry: Entry, operationId: string, resuming: boolean) {
    const temporary = this.temporary(name, operationId);
    const current = await this.current(temporary);
    if (!current || current.kind === 'blocked') return;
    if (!resuming) fail('conflict', `workspace staging conflict: ${temporary}`);
    if (entry.kind === 'file' && current.kind === 'file') {
      const expected = (await this.blob(entry))!;
      const staged = await fs.readFile(path.join(this.workspace, temporary));
      if (staged.length > expected.length || !staged.equals(expected.subarray(0, staged.length))) fail('conflict', `workspace staging conflict: ${temporary}`);
    } else if (!same(current, entry)) fail('conflict', `workspace staging conflict: ${temporary}`);
    await fs.unlink(path.join(this.workspace, temporary));
    await syncDirectory(path.dirname(path.join(this.workspace, temporary)));
  }

  async abort(request: WorkspaceHistoryMove): Promise<WorkspaceHistoryReceipt> {
    assertUuid(request.operationId); assertHash(request.from); assertHash(request.to);
    return this.exclusive(async () => {
      const location = path.join(this.state, 'operations', request.operationId + '.json');
      const prior = await readRecord<WorkspaceHistoryReceipt>(location);
      if (prior) {
        if (prior.from !== request.from || prior.to !== request.to || !['complete', 'cancelled'].includes(prior.status)) fail('identity', 'operation identity already used');
        return prior;
      }
      if (await this.readPending()) fail('pending', 'workspace history operation pending; resume before cancellation');
      const receipt: WorkspaceHistoryReceipt = { ...request, status: 'cancelled', changedPaths: [] };
      await this.saveRecord(location, receipt);
      return receipt;
    });
  }

  async plan(moves: Array<{ from: string; to: string }>): Promise<{ from: string; to: string }> {
    if (!Array.isArray(moves) || !moves.length || moves.length > 1000) fail('invalid', 'invalid history plan size');
    return this.exclusive(async () => {
      if (await this.readPending()) fail('pending', 'workspace history operation pending');
      const source: Record<string, Entry> = Object.create(null);
      const target: Record<string, Entry> = Object.create(null);
      const touched = new Set<string>();
      for (const move of moves) {
        const before = await this.manifest(move.from);
        const after = await this.manifest(move.to);
        for (const name of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
          if (same(before.files[name], after.files[name])) continue;
          if (touched.has(name)) {
            if (!same(target[name], before.files[name])) fail('conflict', `workspace changes conflict between operations: ${name}`);
          } else {
            touched.add(name);
            if (before.files[name]) source[name] = before.files[name];
          }
          if (after.files[name]) target[name] = after.files[name];
          else delete target[name];
        }
      }
      const save = async (files: Record<string, Entry>) => {
        const manifest: Manifest = { version: 1, identity: this.identity, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
        if (Buffer.byteLength(JSON.stringify(manifest)) > 7 * 1024 * 1024) fail('limit', 'checkpoint manifest size limit');
        const id = digest(JSON.stringify(manifest));
        await this.saveRecord(path.join(this.state, 'snapshots', id + '.json'), manifest);
        await this.manifest(id);
        return id;
      };
      return { from: await save(source), to: await save(target) };
    });
  }

  async apply(request: WorkspaceHistoryMove): Promise<WorkspaceHistoryReceipt> {
    assertUuid(request.operationId); assertHash(request.from); assertHash(request.to);
    return this.exclusive(async () => {
      const completedPath = path.join(this.state, 'operations', request.operationId + '.json');
      const completed = await readRecord<WorkspaceHistoryReceipt>(completedPath);
      if (completed) {
        if (completed.from !== request.from || completed.to !== request.to || !['complete', 'cancelled'].includes(completed.status)) fail('identity', 'operation identity already used');
        await this.readPending();
        return completed;
      }
      const pending = await this.readPending();
      if (pending && pending.operationId !== request.operationId) fail('pending', 'another workspace history operation pending');
      if (pending && (pending.from !== request.from || pending.to !== request.to)) fail('identity', 'operation identity already used');
      const source = await this.manifest(request.from);
      const target = await this.manifest(request.to);
      const changedPaths = [...new Set([...Object.keys(source.files), ...Object.keys(target.files)])]
        .filter(name => !same(source.files[name], target.files[name])).sort();
      if (pending && JSON.stringify(changedPaths) !== JSON.stringify(pending.changedPaths)) fail('integrity', 'history operation paths changed');
      for (const name of changedPaths) {
        if (source.files[name]) await this.blob(source.files[name]);
        if (target.files[name]) await this.blob(target.files[name]);
      }
      for (const name of changedPaths) {
        if (target.files[name]) await this.checkStaging(name, target.files[name], request.operationId, !!pending);
      }
      for (const name of changedPaths) await this.verify(name, source, target, !!pending);
      const receipt: WorkspaceHistoryReceipt = { operationId: request.operationId, from: request.from, to: request.to, status: 'applying', changedPaths };
      this.assertStorage(Buffer.byteLength(JSON.stringify(receipt)) * (pending ? 1 : 2) + 256);
      if (!pending) await this.saveRecord(path.join(this.state, 'pending.json'), receipt);
      const removing = changedPaths.filter(name => source.files[name] && (!target.files[name] || target.files[name].kind !== source.files[name].kind));
      for (const name of removing.sort((a, b) => b.length - a.length)) {
        const current = await this.current(name);
        if (current?.kind === 'blocked' && !target.files[name] && parents(name).some(parent => target.files[parent])) continue;
        if (current === null || same(current, target.files[name]) || (current?.kind === 'directory' && !target.files[name])) continue;
        await this.verify(name, source, target, true);
        await fs.unlink(path.join(this.workspace, name));
        await syncDirectory(path.dirname(path.join(this.workspace, name)));
        await this.options.afterMutation?.(name);
      }
      for (const name of changedPaths.filter(name => target.files[name])) {
        if (same(await this.current(name), target.files[name])) continue;
        await this.verify(name, source, target, true);
        await this.ensureParents(name);
        await this.removeEmptyDirectories(name);
        const entry = target.files[name]!;
        const targetPath = path.join(this.workspace, name);
        const temporary = path.join(this.workspace, this.temporary(name, request.operationId));
        if (entry.kind === 'file') await atomicWrite(targetPath, (await this.blob(entry))!, entry.mode, { temporary, ready: () => this.options.afterStaging?.(name) });
        else {
          let created = false;
          try { await fs.symlink(entry.target, temporary); created = true; await this.options.afterStaging?.(name); await fs.rename(temporary, targetPath); await syncDirectory(path.dirname(targetPath)); }
          finally { if (created) await fs.rm(temporary, { force: true }); }
        }
        await this.options.afterMutation?.(name);
      }
      for (const name of changedPaths) {
        const current = await this.current(name);
        if (!same(current, target.files[name]) &&
          !(current?.kind === 'directory' && !target.files[name]) &&
          !(current?.kind === 'blocked' && !target.files[name] && parents(name).some(parent => target.files[parent]))) fail('conflict', `workspace changed during rollback: ${name}`);
      }
      receipt.status = 'complete';
      await this.saveRecord(completedPath, receipt);
      await fs.unlink(path.join(this.state, 'pending.json'));
      await syncDirectory(this.state);
      return receipt;
    });
  }
}
