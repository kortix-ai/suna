/**
 * Config release tree plumbing.
 *
 * Pure git plumbing over the API's bare mirror: resolve a commit's tree, list
 * its files, compose the release tree (the commit's whole tree, minus the
 * plugin entry files an agent variant did not select) in a scratch
 * repository, and build its `tar.gz`. No caches, no store, no governance: the release orchestration
 * lives in `builder.ts`, which re-exports this module's public names. It never
 * calls into a sandbox.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileAsync, runGitCapture, spawn } from '../projects/git/mirror';
import { readManifestAtSha, resolveOpencodeConfigDirAtSha } from '../projects/git/opencode-config-dir';
import type { GitBackedProject } from '../projects/git/types';

/**
 * The release archive cap. A release is the repository's whole tree at the
 * commit (the company project: 248 files, 2.6 MB, 2026-10-05). The daemon's
 * `MAX_CONFIG_ARCHIVE_BYTES` must match.
 */
export const MAX_CONFIG_ARCHIVE_BYTES = 32 * 1024 * 1024;
/** Bound on the uncompressed tar, so a huge repository cannot exhaust memory before the cap trips. The daemon's `MAX_EXTRACTED_BYTES` must match. */
const MAX_CONFIG_TAR_BYTES = 128 * 1024 * 1024;

export const HEX40 = /^[0-9a-f]{40}$/;

/**
 * `project` compiles every agent. `agent:<name>` compiles one selected agent.
 * `none` compiles an EMPTY OpenCode config: the answer for a session with no
 * usable agent (config-releases/session-agent.ts). Its etag is non-null, so a
 * session whose agent the manifest dropped still gets a release ID and still
 * boots, instead of `release_id: null` and no config at all.
 * `meta` is the platform coordinator: the platform's own governance and no
 * config dir. Its box holds no project checkout and its image has no `bun`,
 * so a project config dir with tool dependencies can never load there.
 */
export type ConfigReleaseVariant = 'project' | 'none' | 'meta' | `agent:${string}`;

/** One tracked file: `[path relative to the repository root, git mode, blob ID]`. */
export type ConfigReleaseFile = [path: string, mode: string, blob: string];

export class ConfigArchiveTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`config archive exceeds ${limit} bytes`);
    this.name = 'ConfigArchiveTooLargeError';
  }
}

/** Resolve `git rev-parse <commit>:<config dir>` to a tree ID, or null. */
async function resolveConfigTreeId(
  mirror: string,
  commit: string,
  configDir: string,
): Promise<string | null> {
  // `<commit>:<path>^{tree}` would read `^{tree}` as part of the path, so the
  // object type is checked separately.
  const result = await runGitCapture(['rev-parse', '--verify', '--quiet', `${commit}:${configDir}`], mirror);
  const tree = result.stdout.trim();
  if (result.exitCode !== 0 || !HEX40.test(tree)) return null;
  return (await isTreeObject(mirror, tree)) ? tree : null;
}

/** Is `treeId` a tree object in the mirror? */
export async function isTreeObject(mirror: string, treeId: string): Promise<boolean> {
  if (!HEX40.test(treeId)) return false;
  const result = await runGitCapture(['cat-file', '-t', treeId], mirror);
  return result.exitCode === 0 && result.stdout.trim() === 'tree';
}

/**
 * `git ls-tree -r -z <tree>`: every file with its mode and blob ID. A tree
 * entry of type `commit` (a submodule) is skipped. Symlinks keep mode 120000.
 */
export async function listConfigFiles(
  mirror: string,
  treeId: string,
  env?: Record<string, string>,
): Promise<ConfigReleaseFile[]> {
  const result = await runGitCapture(['ls-tree', '-r', '-z', treeId], mirror, null, env);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-tree ${treeId} failed: ${result.stderr.trim()}`);
  }
  const files: ConfigReleaseFile[] = [];
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, blob] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (type !== 'blob' || !mode || !blob || !path) continue;
    files.push([path, mode, blob]);
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return files;
}

const ARCHIVE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Kortix config release',
  GIT_AUTHOR_EMAIL: 'config-release@kortix.invalid',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'Kortix config release',
  GIT_COMMITTER_EMAIL: 'config-release@kortix.invalid',
  GIT_COMMITTER_DATE: '@0 +0000',
};

/**
 * A scratch bare repository that reads the mirror's objects through
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`. Two reasons:
 * - `info/attributes` neutralises `export-ignore` and `export-subst`. Without
 *   it a `.gitattributes` in the config dir drops or rewrites files, and blob
 *   verification on the box fails.
 * - The fixed-date wrapper commit is written here, so the mirror receives no
 *   writes.
 */
async function withScratchRepo<T>(mirror: string, fn: (repo: string, env: Record<string, string>) => Promise<T>): Promise<T> {
  const repo = await mkdtemp(join(tmpdir(), 'kortix-config-archive-'));
  try {
    const init = await runGitCapture(['init', '--quiet', '--bare', repo], tmpdir());
    if (init.exitCode !== 0) throw new Error(`git init scratch repo failed: ${init.stderr.trim()}`);
    await mkdir(join(repo, 'info'), { recursive: true });
    await writeFile(join(repo, 'info', 'attributes'), '* -export-ignore -export-subst\n');
    // The mirror is bare, so this is `<mirror>/objects`; asking git also
    // covers a non-bare repository.
    const objects = await runGitCapture(['rev-parse', '--git-path', 'objects'], mirror);
    if (objects.exitCode !== 0) throw new Error(`git rev-parse --git-path objects failed: ${objects.stderr.trim()}`);
    const env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(mirror, objects.stdout.trim()), ...ARCHIVE_IDENTITY };
    return await fn(repo, env);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/**
 * Build the `tar.gz` of a config tree: `git archive --format=tar` of a
 * fixed-date commit that wraps the tree, piped through `gzip -n`. `git archive`
 * of a bare tree stamps the current time; the wrapper commit carries mtime 0,
 * so two builds of one tree give identical bytes. Paths are relative to the
 * config dir root. Throws `ConfigArchiveTooLargeError` above `limit` bytes.
 */
export async function buildConfigArchive(
  mirror: string,
  treeId: string,
  limit = MAX_CONFIG_ARCHIVE_BYTES,
): Promise<Buffer> {
  if (!HEX40.test(treeId)) throw new Error(`invalid config tree id: ${treeId}`);
  return withScratchRepo(mirror, (repo, env) => archiveTree(repo, env, treeId, limit));
}

async function archiveTree(
  repo: string,
  env: Record<string, string>,
  treeId: string,
  limit: number,
): Promise<Buffer> {
  const wrapped = await runGitCapture(['commit-tree', treeId, '-m', 'config'], repo, null, env);
  const commit = wrapped.stdout.trim();
  if (wrapped.exitCode !== 0 || !HEX40.test(commit)) {
    throw new Error(`git commit-tree ${treeId} failed: ${wrapped.stderr.trim()}`);
  }
  return archiveThroughGzip(repo, commit, env, limit);
}

/**
 * What a release ships: the commit's whole tree, the same files and folders a
 * checkout of the base branch holds in `/workspace`. Nothing is moved: each
 * harness reads its own dirs inside the release exactly as it reads them in
 * the working tree (`harnesses/opencode`, `skills/`, `harnesses/pi`, …), and a
 * file a config refers to by a relative path is where the repository put it.
 *
 * The one change is per-agent plugin selection (`harnesses.opencode.plugins`
 * in kortix.yaml): an agent variant drops the unselected plugin entry files
 * from `<config dir>/plugins`.
 */
interface ReleaseTreeSource {
  /** The OpenCode config dir inside the tree, or null when the commit has none. */
  configDir: string | null;
  /** The commit's root tree ID in the mirror. */
  rootTree: string;
  /** Selected plugins; null keeps the legacy, globally auto-discovered set. */
  plugins: string[] | null;
  /** Files the tree's `.gitattributes` marks `export-ignore`, left out of the release. */
  exportIgnored: string[];
}

/**
 * Is the release tree composed, rather than the commit's own tree? A composed
 * tree exists in no mirror: its archive URL carries the commit, and the
 * archive route rebuilds it from there.
 */
export function isComposedSource(source: ReleaseTreeSource): boolean {
  return source.plugins !== null || source.exportIgnored.length > 0;
}

/** `git ls-tree -z <tree>`: the tree's records, keyed by entry name. */
async function treeRecords(
  repo: string,
  treeId: string,
  env?: Record<string, string>,
): Promise<Map<string, string>> {
  const result = await runGitCapture(['ls-tree', '-z', treeId], repo, null, env);
  if (result.exitCode !== 0) throw new Error(`git ls-tree ${treeId} failed: ${result.stderr.trim()}`);
  const records = new Map<string, string>();
  for (const record of result.stdout.split('\0')) {
    if (record) records.set(record.slice(record.indexOf('\t') + 1), record);
  }
  return records;
}

/** `git <args>` in `repo` with NUL-terminated `records` on stdin. Throws on a non-zero exit. */
async function gitWithInput(
  repo: string,
  env: Record<string, string>,
  args: string[],
  records: string[],
): Promise<string> {
  const child = spawn('git', args, {
    cwd: repo,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  child.stdin.end(records.map((record) => `${record}\0`).join(''));
  if ((await exit) !== 0) {
    throw new Error(`git ${args[0]} failed: ${Buffer.concat(stderr).toString('utf8').trim()}`);
  }
  return Buffer.concat(stdout).toString('utf8');
}

/** `git mktree -z` in `repo` (never the mirror). mktree sorts the entries itself. */
async function mktree(repo: string, env: Record<string, string>, records: string[]): Promise<string> {
  const tree = (await gitWithInput(repo, env, ['mktree', '-z'], records)).trim();
  if (!HEX40.test(tree)) throw new Error(`git mktree returned no tree: ${tree}`);
  return tree;
}

/** `tree` without `paths`, through a throwaway index in `repo`. */
async function pruneTree(repo: string, env: Record<string, string>, tree: string, paths: string[]): Promise<string> {
  const indexEnv = { ...env, GIT_INDEX_FILE: join(repo, 'release.index') };
  const read = await runGitCapture(['read-tree', tree], repo, null, indexEnv);
  if (read.exitCode !== 0) throw new Error(`git read-tree ${tree} failed: ${read.stderr.trim()}`);
  // Mode 0 removes the entry. `--index-info` needs no work tree; `--force-remove` does.
  await gitWithInput(repo, indexEnv, ['update-index', '-z', '--index-info'], paths.map((path) => `0 ${'0'.repeat(40)}\t${path}`));
  const written = await runGitCapture(['write-tree'], repo, null, indexEnv);
  const pruned = written.stdout.trim();
  if (written.exitCode !== 0 || !HEX40.test(pruned)) throw new Error(`git write-tree failed: ${written.stderr.trim()}`);
  return pruned;
}

/** The tree record's object ID. */
function recordObject(record: string): string {
  return record.slice(0, record.indexOf('\t')).split(' ')[2]!;
}

/**
 * `tree` with the subtree at `path` replaced by `edit(its records)`; an entry
 * left with no records is dropped. Every tree on the way down is rewritten.
 */
async function editTreeAt(
  repo: string,
  env: Record<string, string>,
  tree: string,
  path: string[],
  edit: (records: Map<string, string>) => Map<string, string>,
): Promise<string> {
  const records = await treeRecords(repo, tree, env);
  const [name, ...rest] = path;
  if (name === undefined) return mktree(repo, env, [...edit(records).values()]);
  const record = records.get(name);
  if (!record || record.split(' ')[1] !== 'tree') return tree;
  const edited = await editTreeAt(repo, env, recordObject(record), rest, edit);
  if ((await treeRecords(repo, edited, env)).size === 0) records.delete(name);
  else records.set(name, `040000 tree ${edited}\t${name}`);
  return mktree(repo, env, [...records.values()]);
}

/**
 * The release tree ID of `source`, written into `repo` (a scratch repository
 * that reads the mirror through alternates). Without a plugin selection it is
 * the commit's own root tree.
 */
async function composeReleaseTree(
  repo: string,
  env: Record<string, string>,
  source: ReleaseTreeSource,
): Promise<string> {
  let tree = source.rootTree;
  if (source.plugins !== null && source.configDir !== null) {
    const selected = new Set(source.plugins);
    tree = await editTreeAt(repo, env, tree, [...source.configDir.split('/'), 'plugins'], (entries) => {
      for (const [name, record] of entries) {
        if (/\.[cm]?[jt]s$/.test(name) && record.split(' ')[1] === 'blob' && !selected.has(name)) entries.delete(name);
      }
      return entries;
    });
  }
  if (source.exportIgnored.length > 0) tree = await pruneTree(repo, env, tree, source.exportIgnored);
  return tree;
}

/**
 * The files of `rootTree` its `.gitattributes` marks `export-ignore`, on the
 * file or on one of its directories: what a plain `git archive` leaves out
 * (KRTX-1728). Paths `exempt` keeps are never listed.
 *
 * Read from a throwaway index (`check-attr --cached`), in a scratch repository
 * WITHOUT the archive's neutralising `info/attributes`. `check-attr --source`
 * would need git 2.40; the API image runs 2.39.
 */
async function exportIgnoredPaths(
  mirror: string,
  rootTree: string,
  exempt: (path: string) => boolean,
): Promise<string[]> {
  const files = await listConfigFiles(mirror, rootTree);
  const attributeFiles = files.filter(([path]) => path === '.gitattributes' || path.endsWith('/.gitattributes'));
  // The common case is no rule at all: no index, no scratch repository.
  let named = false;
  for (const [, , blob] of attributeFiles) {
    const text = await runGitCapture(['cat-file', 'blob', blob], mirror);
    if (text.exitCode === 0 && text.stdout.includes('export-ignore')) named = true;
  }
  if (!named) return [];

  const candidates = files.map(([path]) => path).filter((path) => !exempt(path));
  const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  const queried = [...new Set(candidates.flatMap((path) => [...ancestors(path), path]))];
  const repo = await mkdtemp(join(tmpdir(), 'kortix-config-attributes-'));
  try {
    const init = await runGitCapture(['init', '--quiet', '--bare', repo], tmpdir());
    if (init.exitCode !== 0) throw new Error(`git init scratch repo failed: ${init.stderr.trim()}`);
    const objects = await runGitCapture(['rev-parse', '--git-path', 'objects'], mirror);
    if (objects.exitCode !== 0) throw new Error(`git rev-parse --git-path objects failed: ${objects.stderr.trim()}`);
    const env = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(mirror, objects.stdout.trim()),
      GIT_INDEX_FILE: join(repo, 'attributes.index'),
    };
    const read = await runGitCapture(['read-tree', rootTree], repo, null, env);
    if (read.exitCode !== 0) throw new Error(`git read-tree ${rootTree} failed: ${read.stderr.trim()}`);
    // `-z` output: path NUL attribute NUL value NUL, per queried path.
    const out = (await gitWithInput(repo, env, ['check-attr', '--cached', '-z', '--stdin', 'export-ignore'], queried)).split('\0');
    const ignored = new Set<string>();
    for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'set') ignored.add(out[i]!);
    return candidates.filter((path) => ignored.has(path) || ancestors(path).some((dir) => ignored.has(dir)));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/** Compose the release tree of `source` in a scratch repository and read it there.
 *
 * `archive` builds the `tar.gz` too: a boolean, or a predicate over the
 * composed tree ID for callers that decide from the tree ID (the builder
 * skips the build when the archive size is already cached).
 */
export async function readComposedRelease(
  mirror: string,
  source: ReleaseTreeSource,
  options: { archive: boolean | ((treeId: string) => boolean); limit?: number },
): Promise<{ treeId: string; files: ConfigReleaseFile[]; archive: Buffer | null }> {
  return withScratchRepo(mirror, async (repo, env) => {
    const treeId = await composeReleaseTree(repo, env, source);
    const files = await listConfigFiles(repo, treeId, env);
    const wanted = typeof options.archive === 'function' ? options.archive(treeId) : options.archive;
    const archive = wanted
      ? await archiveTree(repo, env, treeId, options.limit ?? MAX_CONFIG_ARCHIVE_BYTES)
      : null;
    return { treeId, files, archive };
  });
}

/** Filename references only. The plugin implementation stays in the repository. */
export function selectedOpenCodePlugins(manifest: Record<string, unknown> | null, agent: string): string[] | null {
  if (manifest?.kortix_version !== 2) return null;
  const global = (manifest.harnesses as { opencode?: { plugins?: string[] } } | undefined)?.opencode?.plugins;
  const agents = manifest.agents as Record<string, { harnesses?: { opencode?: { plugins?: string[]; exclude?: string[] } } }> | undefined;
  const local = agents?.[agent]?.harnesses?.opencode;
  if (!agents?.[agent]) return null;
  if (!global && !local) return null;
  const excluded = new Set(local?.exclude ?? []);
  return [...new Set([...(global ?? []).filter((name) => !excluded.has(name)), ...(local?.plugins ?? [])])];
}

/**
 * The release tree source of `commit`. Shared by the builder and the archive
 * route, which rebuilds a composed tree from the commit in its path.
 */
export async function resolveReleaseTreeSource(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  commit: string,
  variant: ConfigReleaseVariant = 'project',
): Promise<{ source: ReleaseTreeSource } | { configDir: string | null; reason: string }> {
  const rootTree = await resolveConfigTreeId(mirror, commit, '');
  if (!rootTree) return { configDir: null, reason: `commit ${commit} has no tree` };
  const manifest = await readManifestAtSha(mirror, project, commit);
  const configDir = await resolveOpencodeConfigDirAtSha(mirror, project, commit, manifest);
  const plugins = configDir && variant.startsWith('agent:') ? selectedOpenCodePlugins(manifest, variant.slice(6)) : null;
  // The config dir keeps everything, as before (CFG-2): its own `.gitattributes`
  // must not drop or rewrite what the harness loads. So does the manifest.
  const exportIgnored = await exportIgnoredPaths(
    mirror,
    rootTree,
    (path) => path === project.manifestPath || (configDir !== null && path.startsWith(`${configDir}/`)),
  );
  if (configDir && plugins !== null) {
    const configTree = await resolveConfigTreeId(mirror, commit, configDir);
    const available = configTree
      ? (await listConfigFiles(mirror, configTree))
          .filter(([path]) => /^plugins\/[^/]+\.[cm]?[jt]s$/.test(path))
          .map(([path]) => path.slice(8))
      : [];
    const missing = plugins.filter((name) => !available.includes(name));
    if (missing.length) throw new Error(`OpenCode plugin not found in ${configDir}/plugins: ${missing.join(', ')}`);
  }
  return { source: { configDir, rootTree, plugins, exportIgnored } };
}

/**
 * `git archive -o` to a file, then `gzip -n` on that file. Both write to disk:
 * piping one Bun child process into another truncated a 4 MiB archive to
 * 982,058 bytes with exit code 0 (measured 2026-09-21), the same failure class
 * `materializeRepoContext` avoids with a temporary tarball.
 */
async function archiveThroughGzip(
  repo: string,
  commit: string,
  env: Record<string, string>,
  limit: number,
): Promise<Buffer> {
  const tarPath = join(repo, 'config.tar');
  const archived = await runGitCapture(['archive', '--format=tar', '-o', tarPath, commit], repo, null, env);
  if (archived.exitCode !== 0) throw new Error(`git archive ${commit} failed: ${archived.stderr.trim()}`);
  if ((await stat(tarPath)).size > MAX_CONFIG_TAR_BYTES) throw new ConfigArchiveTooLargeError(limit);
  try {
    await execFileAsync('gzip', ['-n', '-f', tarPath], { timeout: 60_000 });
  } catch (error) {
    throw new Error(`gzip -n failed: ${(error as Error).message}`);
  }
  // Read once and measure the bytes read: a stat followed by a read can see
  // two different files (CodeQL js/file-system-race).
  const gz = await readFile(`${tarPath}.gz`);
  if (gz.length > limit) throw new ConfigArchiveTooLargeError(limit);
  return gz;
}
