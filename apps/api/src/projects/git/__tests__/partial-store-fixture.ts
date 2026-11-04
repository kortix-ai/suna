/**
 * Test fixture: a project whose upstream serves partial clones, so the API's
 * store is a real partial store (`object-store.ts`) and every object a read
 * needs must be fetched by id.
 *
 * Two settings make that true, and a local test needs both:
 * - the upstream allows filters and fetches by id (`uploadpack.allowFilter`,
 *   `uploadpack.allowAnySHA1InWant`), as GitHub does;
 * - the project's `repoUrl` is a `file://` URL. Git ignores `--filter` on a
 *   plain path ("--filter is ignored in local clones").
 *
 * The host's git must be 2.45 or later, as in the API image (2.47): older git
 * makes the API keep whole clones (`partialStoresEnabled`), and every
 * assertion here would test that fallback instead. The fixture refuses to
 * start on older git with one clear error.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { repoCachePath } from '../mirror';
import { gitVersionSupportsPartialStores } from '../object-store';
import type { GitBackedProject } from '../types';

const exec = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@kortix.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@kortix.invalid',
};

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: { ...process.env, ...IDENTITY }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export interface PartialStoreFixture {
  root: string;
  /** The bare upstream, as a path (for `git --git-dir`). */
  upstream: string;
  project: GitBackedProject;
  /** Commit `files` (path → content; null deletes) to `branch` of the upstream, as a user pushing from a laptop. Returns the new commit. */
  push(files: Record<string, string | Buffer | null>, message?: string, branch?: string): Promise<string>;
  /** The project's store path on this replica (exists after the first read). */
  storePath(): string;
  /** Objects the store references but does not hold, across every ref. */
  missingObjectCount(): Promise<number>;
  /** Is `oid` in the store? Never fetches. */
  storeHas(oid: string): Promise<boolean>;
  /** The blob id of `path` at `ref` of the upstream. */
  upstreamBlob(path: string, ref?: string): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Create the upstream with `files` on `main`, point `KORTIX_GIT_CACHE_DIR` at
 * a fresh directory, and return a project for it. Call `cleanup` in
 * `afterEach`.
 */
export async function createPartialStoreFixture(
  files: Record<string, string | Buffer>,
  options: { projectId?: string } = {},
): Promise<PartialStoreFixture> {
  const version = await git(['--version']);
  if (!gitVersionSupportsPartialStores(version)) {
    throw new Error(`partial-store tests need git 2.45 or later, as in the API image; this host has "${version}"`);
  }
  const root = await mkdtemp(join(tmpdir(), 'kortix-partial-store-'));
  const upstream = join(root, 'upstream.git');
  const seed = join(root, 'seed');
  const cacheDir = join(root, 'cache');
  const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = cacheDir;

  await git(['init', '--quiet', '--bare', '-b', 'main', upstream]);
  await git(['config', 'uploadpack.allowFilter', 'true'], upstream);
  await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], upstream);
  await git(['init', '--quiet', '-b', 'main', seed]);
  await git(['remote', 'add', 'origin', upstream], seed);

  const push = async (changes: Record<string, string | Buffer | null>, message = 'change', branch = 'main') => {
    const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], seed).catch(() => 'main');
    if (current !== branch) {
      const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], seed).then(() => true, () => false);
      await git(['checkout', '--quiet', ...(exists ? [] : ['-b']), branch], seed);
    }
    for (const [path, content] of Object.entries(changes)) {
      const target = join(seed, path);
      if (content === null) {
        await rm(target, { force: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await git(['add', '-A'], seed);
    await git(['commit', '--quiet', '--allow-empty', '-m', message], seed);
    await git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], seed);
    return git(['rev-parse', 'HEAD'], seed);
  };
  await push(files, 'initial');

  const project: GitBackedProject = {
    projectId: options.projectId ?? `partial-store-${crypto.randomUUID()}`,
    repoUrl: pathToFileURL(upstream).href,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };

  return {
    root,
    upstream,
    project,
    push,
    storePath: () => repoCachePath(project),
    async missingObjectCount() {
      const { stdout } = await exec('git', ['rev-list', '--objects', '--all', '--missing=print'], {
        cwd: repoCachePath(project),
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout.split('\n').filter((line) => line.startsWith('?')).length;
    },
    async storeHas(oid: string) {
      return exec('git', ['cat-file', '-e', oid], {
        cwd: repoCachePath(project),
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      }).then(() => true, () => false);
    },
    upstreamBlob: (path: string, ref = 'main') => git(['rev-parse', `${ref}:${path}`], upstream),
    async cleanup() {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}
