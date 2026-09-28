// A project git upstream that never leaves the machine.
//
// A seeded project's `repoUrl` is what the API's git mirror clones and
// `ls-remote`s. An external URL makes every request that reads the repo wait on
// DNS, TLS, and the mirror's retries before it fails. A bare repository on disk
// answers in milliseconds, and the suite then exercises the real git path.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LocalGitUpstream {
  /** Absolute path of the bare repository. Seed it as the project's `repoUrl`. */
  repoUrl: string;
  /** Deletes the upstream and the mirror cache, and restores `KORTIX_GIT_CACHE_DIR`. */
  remove(): void;
}

/**
 * Creates a bare repository with one commit (`README.md`) on `main`, and points
 * the API's mirror cache (`KORTIX_GIT_CACHE_DIR`) into the same temporary
 * directory, so the suite writes nothing under the shared `/tmp/kortix`.
 */
export function createLocalGitUpstream(label: string): LocalGitUpstream {
  const root = mkdtempSync(join(tmpdir(), `kortix-${label}-`));
  const repoUrl = join(root, 'upstream.git');
  const work = join(root, 'work');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Kortix Test', '-c', 'user.email=test@kortix.invalid', ...args], {
      cwd,
      stdio: 'pipe',
    });

  git(root, 'init', '-q', '--bare', '--initial-branch=main', repoUrl);
  git(root, 'init', '-q', '--initial-branch=main', work);
  writeFileSync(join(work, 'README.md'), `# ${label}\n`);
  git(work, 'add', 'README.md');
  git(work, 'commit', '-q', '-m', 'seed');
  git(work, 'push', '-q', repoUrl, 'main');

  const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'git-cache');

  return {
    repoUrl,
    remove() {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
