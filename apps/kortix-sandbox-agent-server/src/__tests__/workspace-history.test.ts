import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename as fsRename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceHistory } from '../workspace-history';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pi-history-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const state = join(root, 'history');
  await mkdir(workspace);
  const config = { workspace, state, scope: 'project/session', ...options };
  return { root, workspace, state, config, history: new WorkspaceHistory(config) };
}
const capture = (history: WorkspaceHistory) => history.capture(crypto.randomUUID());
const move = (from: string, to: string) => ({ operationId: crypto.randomUUID(), from, to });
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(error);
  return text;
}

test('checkpoints preserve raw binary bytes, executable modes, dangling symlinks and capture idempotency', async () => {
  const { workspace, history } = await fixture();
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  await writeFile(join(workspace, 'binary'), bytes);
  await chmod(join(workspace, 'binary'), 0o755);
  await symlink('missing', join(workspace, 'link'));
  const id = crypto.randomUUID();
  const before = await history.capture(id);
  await writeFile(join(workspace, 'binary'), 'changed');
  await chmod(join(workspace, 'binary'), 0o644);
  await rm(join(workspace, 'link'));
  const after = await capture(history);
  expect(await history.capture(id)).toEqual(before);
  expect(before.files).toBe(2);
  const request = move(after.snapshotId, before.snapshotId);
  expect(await history.apply(request)).toMatchObject({ ...request, status: 'complete', changedPaths: ['binary', 'link'] });
  expect(await readFile(join(workspace, 'binary'))).toEqual(bytes);
  expect((await stat(join(workspace, 'binary'))).mode & 0o777).toBe(0o755);
  expect(await readlink(join(workspace, 'link'))).toBe('missing');
  await writeFile(join(workspace, 'binary'), 'later manual edit');
  expect(await history.apply(request)).toMatchObject({ status: 'complete' });
  expect(await readFile(join(workspace, 'binary'), 'utf8')).toBe('later manual edit');
});

test('rollback and restore cover creations, deletions, renames and preserve unrelated manual edits', async () => {
  const { workspace, history } = await fixture();
  await writeFile(join(workspace, 'old'), 'original');
  await writeFile(join(workspace, 'untouched'), 'base');
  const before = await capture(history);
  await rm(join(workspace, 'old'));
  await mkdir(join(workspace, 'new'));
  await writeFile(join(workspace, 'new', 'renamed'), 'modified');
  const after = await capture(history);
  await writeFile(join(workspace, 'untouched'), 'manual');
  await writeFile(join(workspace, 'manual-new'), 'manual new');
  await history.apply(move(after.snapshotId, before.snapshotId));
  expect(await readFile(join(workspace, 'old'), 'utf8')).toBe('original');
  expect(await Bun.file(join(workspace, 'new', 'renamed')).exists()).toBe(false);
  expect(await readFile(join(workspace, 'untouched'), 'utf8')).toBe('manual');
  expect(await readFile(join(workspace, 'manual-new'), 'utf8')).toBe('manual new');
  await history.apply(move(before.snapshotId, after.snapshotId));
  expect(await readFile(join(workspace, 'new', 'renamed'), 'utf8')).toBe('modified');
  expect(await Bun.file(join(workspace, 'old')).exists()).toBe(false);
  expect(await readFile(join(workspace, 'untouched'), 'utf8')).toBe('manual');
});

test('a changed target rejects the entire rollback before any file changes', async () => {
  const { workspace, history } = await fixture();
  for (const name of ['a', 'z']) await writeFile(join(workspace, name), 'before');
  const before = await capture(history);
  for (const name of ['a', 'z']) await writeFile(join(workspace, name), 'after');
  const after = await capture(history);
  await writeFile(join(workspace, 'z'), 'manual');
  await expect(history.apply(move(after.snapshotId, before.snapshotId))).rejects.toThrow(/conflict/);
  expect(await readFile(join(workspace, 'a'), 'utf8')).toBe('after');
  expect(await readFile(join(workspace, 'z'), 'utf8')).toBe('manual');
  expect(await history.pending()).toBeNull();
});

test('directory and file replacements preserve unexpected files and never follow a symlink ancestor', async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, 'entry'), 'file');
  const before = await capture(history);
  await rm(join(workspace, 'entry'));
  await mkdir(join(workspace, 'entry'));
  await writeFile(join(workspace, 'entry', 'nested'), 'nested');
  const after = await capture(history);
  await writeFile(join(workspace, 'entry', 'manual'), 'preserve');
  await expect(history.apply(move(after.snapshotId, before.snapshotId))).rejects.toThrow(/conflict/);
  expect(await readFile(join(workspace, 'entry', 'manual'), 'utf8')).toBe('preserve');
  await rm(join(workspace, 'entry', 'manual'));
  await history.apply(move(after.snapshotId, before.snapshotId));
  expect(await readFile(join(workspace, 'entry'), 'utf8')).toBe('file');
  await history.apply(move(before.snapshotId, after.snapshotId));
  expect(await readFile(join(workspace, 'entry', 'nested'), 'utf8')).toBe('nested');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'nested'), 'outside');
  await rm(join(workspace, 'entry'), { recursive: true });
  await symlink(outside, join(workspace, 'entry'));
  await expect(history.apply(move(after.snapshotId, before.snapshotId))).rejects.toThrow(/conflict/);
  expect(await readFile(join(outside, 'nested'), 'utf8')).toBe('outside');
});

test('Git-visible checkpoints preserve ignored files, raw attributes, staged changes, HEAD and index bytes', async () => {
  const { workspace, history } = await fixture();
  await git(workspace, 'init', '-q');
  await git(workspace, 'config', 'user.email', 'test@example.test');
  await git(workspace, 'config', 'user.name', 'Test');
  await writeFile(join(workspace, '.gitignore'), 'ignored\n');
  await writeFile(join(workspace, '.gitattributes'), '*.txt text eol=lf\n');
  await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  await git(workspace, 'add', '.');
  await git(workspace, 'commit', '-qm', 'base');
  await writeFile(join(workspace, 'tracked.txt'), 'staged\r\n');
  await git(workspace, 'add', 'tracked.txt');
  const index = await readFile(join(workspace, '.git', 'index'));
  const head = await git(workspace, 'rev-parse', 'HEAD');
  await writeFile(join(workspace, 'ignored'), 'private');
  const before = await capture(history);
  await writeFile(join(workspace, 'tracked.txt'), 'tool changed');
  await writeFile(join(workspace, 'ignored'), 'private updated');
  const after = await capture(history);
  await history.apply(move(after.snapshotId, before.snapshotId));
  expect(await readFile(join(workspace, 'tracked.txt'), 'utf8')).toBe('staged\r\n');
  expect(await readFile(join(workspace, 'ignored'), 'utf8')).toBe('private updated');
  expect(await readFile(join(workspace, '.git', 'index'))).toEqual(index);
  expect(await git(workspace, 'rev-parse', 'HEAD')).toBe(head);
});

test('interrupted application resumes from its durable receipt and blocks different operations or checkpoints', async () => {
  let writes = 0;
  const { workspace, config, history } = await fixture({ afterMutation: () => { if (++writes === 1) throw new Error('injected crash'); } });
  for (const name of ['a', 'b']) await writeFile(join(workspace, name), 'before');
  const before = await capture(history);
  for (const name of ['a', 'b']) await writeFile(join(workspace, name), 'after');
  const after = await capture(history);
  const request = move(after.snapshotId, before.snapshotId);
  await expect(history.apply(request)).rejects.toThrow('injected crash');
  const recovered = new WorkspaceHistory({ ...config, afterMutation: undefined });
  expect(await recovered.pending()).toMatchObject({ ...request, status: 'applying' });
  await expect(capture(recovered)).rejects.toThrow(/pending/);
  await expect(recovered.apply(move(after.snapshotId, before.snapshotId))).rejects.toThrow(/pending/);
  expect(await recovered.apply(request)).toMatchObject({ status: 'complete' });
  for (const name of ['a', 'b']) expect(await readFile(join(workspace, name), 'utf8')).toBe('before');
  expect(await recovered.pending()).toBeNull();
  await expect(recovered.apply({ ...request, to: after.snapshotId })).rejects.toThrow(/identity/);
});

test('corrupt blobs, absent checkpoints, foreign scope and invalid IDs fail without changing workspace files', async () => {
  const { workspace, state, config, history } = await fixture();
  await writeFile(join(workspace, 'a'), 'before');
  const before = await capture(history);
  await writeFile(join(workspace, 'a'), 'after');
  const after = await capture(history);
  await expect(history.apply(move('0'.repeat(64), before.snapshotId))).rejects.toThrow(/checkpoint/);
  await expect(history.capture('../escape')).rejects.toThrow(/identity/);
  await expect(new WorkspaceHistory({ ...config, scope: 'another/session' }).capture(crypto.randomUUID())).rejects.toThrow(/identity/);
  for (const name of await readdir(join(state, 'blobs'))) await writeFile(join(state, 'blobs', name), 'corrupt');
  await expect(history.apply(move(after.snapshotId, before.snapshotId))).rejects.toThrow(/integrity/);
  expect(await readFile(join(workspace, 'a'), 'utf8')).toBe('after');
});

test('capture limits and state inside the workspace fail without publishing a partial checkpoint', async () => {
  const { workspace, state, history } = await fixture({ maxBytes: 3 });
  await writeFile(join(workspace, 'a'), 'too large');
  await expect(capture(history)).rejects.toThrow(/limit/);
  expect(await readdir(join(state, 'captures'))).toEqual([]);
  await expect(new WorkspaceHistory({ workspace, state: join(workspace, 'state'), scope: 's' }).capture(crypto.randomUUID())).rejects.toThrow(/outside/);
});

test.each([
  ['file', 'directory'], ['directory', 'file'], ['symlink', 'directory'], ['directory', 'symlink'],
  ['file', 'symlink'], ['symlink', 'file'], ['absent', 'directory'], ['directory', 'absent'],
])('recovery after the first mutation preserves %s to %s transitions', async (beforeKind, afterKind) => {
  const { workspace, config, history } = await fixture();
  const put = async (kind: string, text: string) => {
    await rm(join(workspace, 'entry'), { recursive: true, force: true });
    if (kind === 'directory') {
      await mkdir(join(workspace, 'entry', 'deep'), { recursive: true });
      await writeFile(join(workspace, 'entry', 'deep', 'a'), text);
      await writeFile(join(workspace, 'entry', 'b'), text);
    } else if (kind === 'file') await writeFile(join(workspace, 'entry'), text);
    else if (kind === 'symlink') await symlink(text, join(workspace, 'entry'));
  };
  await put(beforeKind, 'before');
  const before = await capture(history);
  await put(afterKind, 'after');
  const after = await capture(history);
  const request = move(after.snapshotId, before.snapshotId);
  const interrupted = new WorkspaceHistory({ ...config, afterMutation: () => { throw new Error('crash'); } });
  await expect(interrupted.apply(request)).rejects.toThrow('crash');
  expect(await history.apply(request)).toMatchObject({ status: 'complete' });
  expect((await capture(history)).snapshotId).toBe(before.snapshotId);
});

test('a killed process releases the history lock and a new process finishes the same receipt', async () => {
  const { workspace, config, history } = await fixture();
  for (const name of ['a', 'b']) await writeFile(join(workspace, name), 'before');
  const before = await capture(history);
  for (const name of ['a', 'b']) await writeFile(join(workspace, name), 'after');
  const after = await capture(history);
  const request = move(after.snapshotId, before.snapshotId);
  const module = new URL('../workspace-history.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, '-e', `import { WorkspaceHistory } from ${JSON.stringify(module)};
    await new WorkspaceHistory({...${JSON.stringify(config)},afterMutation:()=>process.kill(process.pid,'SIGKILL')}).apply(${JSON.stringify(request)});`], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).not.toBe(0);
  expect(await history.pending()).toMatchObject({ status: 'applying' });
  expect(await history.apply(request)).toMatchObject({ status: 'complete' });
  for (const name of ['a', 'b']) expect(await readFile(join(workspace, name), 'utf8')).toBe('before');
});

test('concurrent managers reject another operation before any mutation', async () => {
  const { workspace, config, history } = await fixture();
  await writeFile(join(workspace, 'a'), 'before');
  const before = await capture(history);
  await writeFile(join(workspace, 'a'), 'after');
  const after = await capture(history);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const manager = new WorkspaceHistory({ ...config, afterMutation: async () => { entered.resolve(); await release.promise; } });
  const pending = manager.apply(move(after.snapshotId, before.snapshotId));
  try {
    await entered.promise;
    await expect(capture(history)).rejects.toThrow(/busy/);
  } finally { release.resolve(); }
  await pending;
  expect(await readFile(join(workspace, 'a'), 'utf8')).toBe('before');
});

test('manual edits after an interrupted rollback are preserved and leave recovery pending', async () => {
  const { workspace, config, history } = await fixture();
  for (const name of ['a', 'b']) await writeFile(join(workspace, name), 'before');
  const before = await capture(history);
  for (const name of ['a', 'b']) await writeFile(join(workspace, name), 'after');
  const after = await capture(history);
  const request = move(after.snapshotId, before.snapshotId);
  await expect(new WorkspaceHistory({ ...config, afterMutation: () => { throw new Error('crash'); } }).apply(request)).rejects.toThrow('crash');
  await writeFile(join(workspace, 'a'), 'manual');
  await expect(history.apply(request)).rejects.toThrow(/conflict/);
  expect(await readFile(join(workspace, 'a'), 'utf8')).toBe('manual');
  expect(await readFile(join(workspace, 'b'), 'utf8')).toBe('after');
  expect(await history.pending()).toMatchObject({ status: 'applying' });
});

test('ordinary filenames cannot inherit object prototype entries', async () => {
  const { workspace, history } = await fixture();
  const before = await capture(history);
  for (const name of ['__proto__', 'constructor', 'toString']) await writeFile(join(workspace, name), name);
  const after = await capture(history);
  await history.apply(move(after.snapshotId, before.snapshotId));
  expect(await readdir(workspace)).toEqual([]);
  await history.apply(move(before.snapshotId, after.snapshotId));
  for (const name of ['__proto__', 'constructor', 'toString']) expect(await readFile(join(workspace, name), 'utf8')).toBe(name);
});

test('directory traversal has a separate entry budget and depth limit', async () => {
  const { workspace, history } = await fixture({ maxEntries: 2 });
  for (const name of ['a', 'b', 'c']) await mkdir(join(workspace, name));
  await expect(capture(history)).rejects.toThrow(/entry count limit/);
  const deep = await fixture({ maxDepth: 2 });
  await mkdir(join(deep.workspace, 'a', 'b', 'c'), { recursive: true });
  await expect(capture(deep.history)).rejects.toThrow(/depth limit/);
});

test('a killed process leaves a known staging file that the next process recovers', async () => {
  const { workspace, config, history } = await fixture();
  await writeFile(join(workspace, 'a'), 'before');
  const before = await capture(history);
  await writeFile(join(workspace, 'a'), 'after');
  const after = await capture(history);
  const request = move(after.snapshotId, before.snapshotId);
  const module = new URL('../workspace-history.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, '-e', `import { WorkspaceHistory } from ${JSON.stringify(module)};
    await new WorkspaceHistory({...${JSON.stringify(config)},afterStaging:()=>process.kill(process.pid,'SIGKILL')}).apply(${JSON.stringify(request)});`], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).not.toBe(0);
  expect(await readdir(workspace)).toHaveLength(2);
  expect(await history.apply(request)).toMatchObject({ status: 'complete' });
  expect(await readdir(workspace)).toEqual(['a']);
  expect(await readFile(join(workspace, 'a'), 'utf8')).toBe('before');
});

test('a replaced workspace cannot reuse checkpoints from the old directory', async () => {
  const { workspace, history } = await fixture();
  await capture(history);
  await fsRename(workspace, workspace + '-old');
  await mkdir(workspace);
  await expect(capture(history)).rejects.toThrow(/identity changed/);
});

test('stored history is bounded across captures and deduplicates unchanged file bytes', async () => {
  const { workspace, state, history } = await fixture({ maxHistoryBytes: 8000 });
  await writeFile(join(workspace, 'a'), Buffer.alloc(3500, 1));
  await capture(history);
  await capture(history);
  expect(await readdir(join(state, 'blobs'))).toHaveLength(1);
  await writeFile(join(workspace, 'a'), Buffer.alloc(3500, 2));
  await expect(capture(history)).rejects.toThrow(/history storage limit/);
  expect(await readdir(join(state, 'captures'))).toHaveLength(2);
});
