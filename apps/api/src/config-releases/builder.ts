/**
 * Config release builder (docs/specs/config-releases.md, "Release builder").
 *
 * A config release is one config archive plus one compiled governance. The
 * archive is keyed by the config tree ID, so every commit and every variant
 * with identical config files shares one archive. The builder reads only the
 * API's bare mirror. It never calls into a sandbox.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileAsync, refreshMirror, runGitCapture } from '../projects/git/mirror';
import { resolveOpencodeConfigDirAtSha } from '../projects/git/opencode-config-dir';
import type { GitBackedProject } from '../projects/git/types';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from '../projects/lib/compile-agent-config';
import { configArchiveKey, getConfigArchiveStore, type ConfigArchiveStore } from './store';

export const CONFIG_RELEASE_FORMAT = 'config-release-v1';
/** Same limit as `MAX_OPENCODE_CONFIG_ARCHIVE_BYTES` in git-proxy/compiled-runtime-artifact.ts. */
export const MAX_CONFIG_ARCHIVE_BYTES = 4 * 1024 * 1024;
/** Bound on the uncompressed tar, so a huge config dir cannot exhaust memory before the cap trips. */
const MAX_CONFIG_TAR_BYTES = 64 * 1024 * 1024;

const HEX40 = /^[0-9a-f]{40}$/;

export type ConfigMode = 'follow-base' | 'session-files';

/** `project` compiles every agent. `agent:<name>` compiles one selected agent. */
export type ConfigReleaseVariant = 'project' | `agent:${string}`;

/** One tracked file: `[path relative to the config dir, git mode, blob ID]`. */
export type ConfigReleaseFile = [path: string, mode: string, blob: string];

export interface ConfigReleaseDescriptor {
  format: typeof CONFIG_RELEASE_FORMAT;
  /** `sha256(config_tree_id + ":" + (compiled_governance_etag ?? ""))`, hex. Null when there is no release. */
  release_id: string | null;
  mode: ConfigMode;
  source_commit: string;
  config_dir: string | null;
  config_tree_id: string | null;
  archive: { url: string; bytes: number } | null;
  files: ConfigReleaseFile[] | null;
  compiled_governance: string | null;
  compiled_governance_etag: string | null;
  /** Why there is no release, or null. */
  reason: string | null;
}

/** The mode-independent part of a descriptor. Cached per `(project, commit, variant)`. */
export type ConfigRelease = Omit<ConfigReleaseDescriptor, 'mode'>;

export class ConfigArchiveTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`config archive exceeds ${limit} bytes`);
    this.name = 'ConfigArchiveTooLargeError';
  }
}

export class ConfigReleaseCommitNotFoundError extends Error {
  constructor(readonly commit: string) {
    super(`commit ${commit} is not in the project mirror`);
    this.name = 'ConfigReleaseCommitNotFoundError';
  }
}

export function configReleaseId(configTreeId: string, compiledGovernanceEtag: string | null): string {
  return createHash('sha256')
    .update(`${configTreeId}:${compiledGovernanceEtag ?? ''}`)
    .digest('hex');
}

export function configArchiveRoute(projectId: string, configTreeId: string): string {
  return `/v1/projects/${projectId}/config-archives/${configTreeId}`;
}

/** Resolve `git rev-parse <commit>:<config dir>` to a tree ID, or null. */
export async function resolveConfigTreeId(
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
export async function listConfigFiles(mirror: string, treeId: string): Promise<ConfigReleaseFile[]> {
  const result = await runGitCapture(['ls-tree', '-r', '-z', treeId], mirror);
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
    const env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(resolve(mirror), 'objects'), ...ARCHIVE_IDENTITY };
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
  return withScratchRepo(mirror, async (repo, env) => {
    const wrapped = await runGitCapture(['commit-tree', treeId, '-m', 'config'], repo, null, env);
    const commit = wrapped.stdout.trim();
    if (wrapped.exitCode !== 0 || !HEX40.test(commit)) {
      throw new Error(`git commit-tree ${treeId} failed: ${wrapped.stderr.trim()}`);
    }
    return archiveThroughGzip(repo, commit, env, limit);
  });
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
  const gzPath = `${tarPath}.gz`;
  if ((await stat(gzPath)).size > limit) throw new ConfigArchiveTooLargeError(limit);
  return readFile(gzPath);
}

interface CachedRelease {
  release: ConfigRelease;
  at: number;
}

const MAX_CACHED_RELEASES = 1_000;
const releases = new Map<string, CachedRelease>();
const inflight = new Map<string, Promise<ConfigRelease>>();
/** Archive byte counts per store key. The archive is deterministic per tree ID. */
const archiveBytes = new Map<string, number>();
const MAX_CACHED_ARCHIVE_SIZES = 5_000;

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as K;
    map.delete(oldest);
  }
}

export interface BuildConfigReleaseOptions {
  store?: ConfigArchiveStore;
  /** Tests only: skip the in-memory descriptor cache. */
  noCache?: boolean;
}

/**
 * Put the archive into the store. The store is a cache: a failure is logged
 * and the archive route streams a fresh build instead.
 */
export async function storeConfigArchive(
  store: ConfigArchiveStore,
  key: string,
  archive: Buffer,
): Promise<'created' | 'exists' | 'failed'> {
  try {
    return await store.putIfAbsent(key, archive);
  } catch (error) {
    console.warn(`[config-releases] store put ${key} failed; the archive route streams from the mirror: ${(error as Error).message}`);
    return 'failed';
  }
}

async function compileGovernance(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
): Promise<string | null> {
  if (variant === 'project') return resolveCompiledAgentConfigForSession(project, commit);
  return resolveSelectedAgentConfigForSession(project, variant.slice('agent:'.length), commit);
}

async function build(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
  store: ConfigArchiveStore,
): Promise<ConfigRelease> {
  let mirror = await refreshMirror(project);
  // A commit the warm mirror has not fetched yet: fetch once, then give up.
  if ((await runGitCapture(['cat-file', '-e', `${commit}^{commit}`], mirror)).exitCode !== 0) {
    mirror = await refreshMirror(project, true);
    if ((await runGitCapture(['cat-file', '-e', `${commit}^{commit}`], mirror)).exitCode !== 0) {
      throw new ConfigReleaseCommitNotFoundError(commit);
    }
  }
  const base: ConfigRelease = {
    format: CONFIG_RELEASE_FORMAT,
    release_id: null,
    source_commit: commit,
    config_dir: null,
    config_tree_id: null,
    archive: null,
    files: null,
    compiled_governance: null,
    compiled_governance_etag: null,
    reason: null,
  };

  // Governance first: a selected-agent compile failure means no release. The
  // session keeps its running config rather than run without its agent.
  let governance: string | null;
  try {
    governance = await compileGovernance(project, commit, variant);
  } catch (error) {
    return { ...base, reason: `compiled governance failed: ${(error as Error).message}` };
  }
  const etag = agentConfigEtag(governance);
  const withGovernance: ConfigRelease = {
    ...base,
    compiled_governance: governance,
    compiled_governance_etag: etag,
  };

  const configDir = await resolveOpencodeConfigDirAtSha(mirror, project, commit);
  if (!configDir) {
    return { ...withGovernance, reason: 'the commit has no OpenCode config dir' };
  }
  const treeId = await resolveConfigTreeId(mirror, commit, configDir);
  if (!treeId) {
    return { ...withGovernance, config_dir: configDir, reason: `config dir ${configDir} is not a tree at ${commit}` };
  }
  const located: ConfigRelease = { ...withGovernance, config_dir: configDir, config_tree_id: treeId };

  const key = configArchiveKey(project.projectId, treeId);
  let bytes = archiveBytes.get(key);
  if (bytes === undefined) {
    let archive: Buffer;
    try {
      archive = await buildConfigArchive(mirror, treeId);
    } catch (error) {
      if (error instanceof ConfigArchiveTooLargeError) {
        return { ...located, reason: `config dir ${configDir} exceeds the ${MAX_CONFIG_ARCHIVE_BYTES}-byte archive limit` };
      }
      throw error;
    }
    await storeConfigArchive(store, key, archive);
    bytes = archive.length;
    remember(archiveBytes, key, bytes, MAX_CACHED_ARCHIVE_SIZES);
  }

  return {
    ...located,
    release_id: configReleaseId(treeId, etag),
    archive: { url: configArchiveRoute(project.projectId, treeId), bytes },
    files: await listConfigFiles(mirror, treeId),
  };
}

/**
 * Build (or read from the in-memory cache) the release for one commit and one
 * variant. `commit` must be a full commit SHA the mirror already holds. The
 * caller resolves the base tip after `invalidateProjectMirror`.
 */
export async function buildConfigRelease(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
  options: BuildConfigReleaseOptions = {},
): Promise<ConfigRelease> {
  if (!HEX40.test(commit)) throw new Error(`invalid commit: ${commit}`);
  const store = options.store ?? getConfigArchiveStore();
  if (options.noCache) return build(project, commit, variant, store);

  const cacheKey = `${project.projectId}\0${commit}\0${variant}`;
  const cached = releases.get(cacheKey);
  if (cached) return cached.release;
  const running = inflight.get(cacheKey);
  if (running) return running;
  const next = build(project, commit, variant, store)
    .then((release) => {
      // A release with a reason can be transient (a compile read that failed).
      // Only complete releases are cached.
      if (release.release_id) remember(releases, cacheKey, { release, at: Date.now() }, MAX_CACHED_RELEASES);
      return release;
    })
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, next);
  return next;
}

export const REPOSITORY_ACCESS_WITHHELD = 'repository access withheld';

/**
 * Combine a release with the mode the API chose.
 * - `session-files` carries no archive and no files.
 * - A session without repository access never receives an archive: it gets no
 *   repository URL and no clone (`allowsFullRepository`), and the archive would
 *   disclose files that mode withholds. It keeps the compiled governance.
 */
export function toDescriptor(
  release: ConfigRelease,
  mode: ConfigMode,
  options: { repositoryAccess: boolean } = { repositoryAccess: true },
): ConfigReleaseDescriptor {
  if (!options.repositoryAccess) {
    return {
      ...release,
      mode,
      release_id: null,
      config_dir: null,
      config_tree_id: null,
      archive: null,
      files: null,
      reason: REPOSITORY_ACCESS_WITHHELD,
    };
  }
  if (mode === 'session-files') return { ...release, mode, archive: null, files: null };
  return { ...release, mode };
}

export function __clearConfigReleaseCachesForTests(): void {
  releases.clear();
  inflight.clear();
  archiveBytes.clear();
}
