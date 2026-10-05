/**
 * Config release tree plumbing.
 *
 * Pure git plumbing over the API's bare mirror: resolve the config dir's tree,
 * list its files, compose the release tree (the config dir, plus the root
 * `skills/` dir and the pi config dir) in a scratch repository, and build its
 * `tar.gz`. No caches, no store, no governance: the release orchestration
 * lives in `builder.ts`, which re-exports this module's public names. It never
 * calls into a sandbox.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SKILLS_DIR, opencodeConfigDirCandidates, piConfigDirCandidates } from '@kortix/manifest-schema';
import { execFileAsync, runGitCapture, spawn } from '../projects/git/mirror';
import { readManifestAtSha, resolveOpencodeConfigDirAtSha } from '../projects/git/opencode-config-dir';
import type { GitBackedProject } from '../projects/git/types';

/**
 * The release archive cap. A release carries the root `skills/` too, and a
 * skill with templates, fonts or images passed the old 4 MiB in one file
 * (2026-10-05). The daemon's `MAX_CONFIG_ARCHIVE_BYTES` must match.
 */
export const MAX_CONFIG_ARCHIVE_BYTES = 32 * 1024 * 1024;
/** Bound on the uncompressed tar, so a huge config dir cannot exhaust memory before the cap trips. The daemon's `MAX_EXTRACTED_BYTES` must match. */
const MAX_CONFIG_TAR_BYTES = 128 * 1024 * 1024;

export const HEX40 = /^[0-9a-f]{40}$/;
/** Git's empty tree. Every repository resolves it without storing it. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

/** One tracked file: `[path relative to the config dir, git mode, blob ID]`. */
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
 * What a config release tree is made of at one commit.
 *
 * The OpenCode config dir, plus the skills of the root `skills/` dir (the
 * harness-neutral project layout, `@kortix/manifest-schema/layout`), plus the
 * pi config dir as `pi/`. A root skill replaces a config-dir skill of the same
 * name. Only a root entry that holds a `SKILL.md` counts, so an unrelated
 * `skills/` folder in a code repository adds nothing.
 */
interface ReleaseTreeSource {
  configDir: string;
  /** The config dir's own tree ID in the mirror. */
  configTree: string;
  /** Root `skills/` entries, as `git ls-tree -z` records, that hold a SKILL.md. */
  rootSkills: string[];
  /** Selected plugins; null keeps the legacy, globally auto-discovered set. */
  plugins: string[] | null;
  /** The pi config dir's tree ID (`piConfigDirCandidates`), or null when the commit has none. */
  piTree: string | null;
}

/** The pi config dir's place in a release: pi reads `<release>/pi`; OpenCode ignores it. */
const PI_RELEASE_DIR = 'pi';

/**
 * Is the release tree composed, rather than the config dir's own tree? A
 * composed tree exists in no mirror: its archive URL carries the commit, and
 * the archive route rebuilds it from there.
 */
export function isComposedSource(source: ReleaseTreeSource): boolean {
  return source.rootSkills.length > 0 || source.plugins !== null || source.piTree !== null;
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

/** The root `skills/` entries of `commit` that hold a SKILL.md, sorted by name. */
async function rootSkillRecords(mirror: string, commit: string): Promise<string[]> {
  const tree = await resolveConfigTreeId(mirror, commit, SKILLS_DIR);
  if (!tree) return [];
  const listed = await runGitCapture(['ls-tree', '-r', '-z', '--name-only', tree], mirror);
  if (listed.exitCode !== 0) throw new Error(`git ls-tree ${tree} failed: ${listed.stderr.trim()}`);
  const withSkill = new Set(
    listed.stdout
      .split('\0')
      .filter((path) => path.endsWith('/SKILL.md'))
      .map((path) => path.slice(0, path.indexOf('/'))),
  );
  return [...(await treeRecords(mirror, tree)).entries()]
    .filter(([name, record]) => withSkill.has(name) && record.split(' ')[1] === 'tree')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, record]) => record);
}

/** `git mktree -z` in `repo` (never the mirror). mktree sorts the entries itself. */
async function mktree(repo: string, env: Record<string, string>, records: string[]): Promise<string> {
  const child = spawn('git', ['mktree', '-z'], {
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
  const code = await exit;
  const tree = Buffer.concat(stdout).toString('utf8').trim();
  if (code !== 0 || !HEX40.test(tree)) {
    throw new Error(`git mktree failed: ${Buffer.concat(stderr).toString('utf8').trim()}`);
  }
  return tree;
}

/**
 * The release tree ID of `source`, written into `repo` (a scratch repository
 * that reads the mirror through alternates). With no root skills and no pi
 * config dir it is the config dir's own tree, so a project on the legacy
 * layout keeps its tree ID, its release ID and its archive bytes exactly.
 */
async function composeReleaseTree(
  repo: string,
  env: Record<string, string>,
  source: ReleaseTreeSource,
): Promise<string> {
  if (!isComposedSource(source)) return source.configTree;
  const top = await treeRecords(repo, source.configTree, env);
  if (source.rootSkills.length) {
    const skills = new Map<string, string>();
    const configSkills = top.get(SKILLS_DIR);
    if (configSkills && configSkills.split(' ')[1] === 'tree') {
      const tree = configSkills.slice(0, configSkills.indexOf('\t')).split(' ')[2]!;
      for (const [name, record] of await treeRecords(repo, tree, env)) skills.set(name, record);
    }
    for (const record of source.rootSkills) skills.set(record.slice(record.indexOf('\t') + 1), record);
    top.set(SKILLS_DIR, `040000 tree ${await mktree(repo, env, [...skills.values()])}\t${SKILLS_DIR}`);
  }
  if (source.plugins !== null) {
    const selected = new Set(source.plugins);
    const pluginTree = top.get('plugins');
    if (pluginTree) {
      const tree = pluginTree.slice(0, pluginTree.indexOf('\t')).split(' ')[2]!;
      const entries = await treeRecords(repo, tree, env);
      for (const [name, record] of entries) {
        if (/\.[cm]?[jt]s$/.test(name) && record.split(' ')[1] === 'blob' && !selected.has(name)) entries.delete(name);
      }
      if (entries.size) top.set('plugins', `040000 tree ${await mktree(repo, env, [...entries.values()])}\tplugins`);
      else top.delete('plugins');
    }
  }
  // Replaces a `pi/` folder of the OpenCode config dir, which no reader loads.
  if (source.piTree) top.set(PI_RELEASE_DIR, `040000 tree ${source.piTree}\t${PI_RELEASE_DIR}`);
  return mktree(repo, env, [...top.values()]);
}

/** The first `piConfigDirCandidates` entry that is a tree at `commit`, or null. */
async function resolvePiConfigTree(
  mirror: string,
  commit: string,
  manifest: Record<string, unknown> | null,
): Promise<string | null> {
  for (const dir of piConfigDirCandidates(manifest)) {
    const tree = await resolveConfigTreeId(mirror, commit, dir);
    if (tree) return tree;
  }
  return null;
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
 * The release tree source of `commit`, or a reason there is none. Shared by
 * the builder and the archive route, which rebuilds a composed tree from the
 * commit in its path.
 */
export async function resolveReleaseTreeSource(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  commit: string,
  variant: ConfigReleaseVariant = 'project',
): Promise<{ source: ReleaseTreeSource } | { configDir: string | null; reason: string }> {
  const manifest = await readManifestAtSha(mirror, project, commit);
  const configDir = await resolveOpencodeConfigDirAtSha(mirror, project, commit, manifest);
  const configTree = configDir ? await resolveConfigTreeId(mirror, commit, configDir) : null;
  if (!configDir || !configTree) {
    // No OpenCode config dir. The root skills and the pi config dir still ship,
    // on an empty one: a pi-only project otherwise lost both (2026-10-05).
    const rootSkills = await rootSkillRecords(mirror, commit);
    const piTree = await resolvePiConfigTree(mirror, commit, manifest);
    if (!rootSkills.length && !piTree) {
      return configDir
        ? { configDir, reason: `config dir ${configDir} is not a tree at ${commit}` }
        : { configDir: null, reason: 'the commit has no OpenCode config dir' };
    }
    return {
      source: {
        configDir: configDir ?? opencodeConfigDirCandidates(manifest)[0]!,
        configTree: EMPTY_TREE,
        rootSkills,
        plugins: null,
        piTree,
      },
    };
  }
  const plugins = variant.startsWith('agent:') ? selectedOpenCodePlugins(manifest, variant.slice(6)) : null;
  if (plugins !== null) {
    const available = (await listConfigFiles(mirror, configTree))
      .filter(([path]) => /^plugins\/[^/]+\.[cm]?[jt]s$/.test(path))
      .map(([path]) => path.slice(8));
    const missing = plugins.filter((name) => !available.includes(name));
    if (missing.length) throw new Error(`OpenCode plugin not found in ${configDir}/plugins: ${missing.join(', ')}`);
  }
  return {
    source: {
      configDir,
      configTree,
      rootSkills: await rootSkillRecords(mirror, commit),
      plugins,
      piTree: await resolvePiConfigTree(mirror, commit, manifest),
    },
  };
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
