import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `kortix ship` on a machine with no git identity: a fresh laptop or a
// container has no user.email, and `git commit` refuses with "Author identity
// unknown". Ship then commits as the Kortix login. A configured identity wins.
//
// The commit step runs in a child process with a clean environment (its own
// HOME, no global or system git config), the state a fresh machine is in.

const GIT_OPS = resolve(import.meta.dir, '../git-ops.ts');

let root: string;
let repo: string;
let env: Record<string, string>;

function git(args: string[]) {
  return spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
}

/** Run ship's commit step in `repo`, as `kortix ship` would, with `loginEmail`. */
function shipCommit(loginEmail?: string): number | null {
  const code = `import { commitIfNeeded } from ${JSON.stringify(GIT_OPS)};
process.exit(commitIfNeeded({ noCommit: false }, ${JSON.stringify(loginEmail ?? null)} ?? undefined) === 'ok' ? 0 : 1);`;
  return spawnSync(process.execPath, ['-e', code], { cwd: repo, env, encoding: 'utf8' }).status;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-ship-identity-'));
  repo = join(root, 'repo');
  mkdirSync(join(root, 'home'));
  mkdirSync(repo);
  env = {
    PATH: process.env.PATH ?? '',
    HOME: join(root, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  git(['init', '-q', '-b', 'main']);
  // Only a configured identity counts, as on a host whose name gives git no
  // usable email: the failure a fresh machine shows.
  git(['config', 'user.useConfigOnly', 'true']);
  writeFileSync(join(repo, 'kortix.yaml'), 'project:\n  name: demo\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('with no git identity, ship commits as the Kortix login', () => {
  expect(shipCommit('person@example.test')).toBe(0);
  expect(git(['log', '-1', '--format=%ae %an']).stdout.trim()).toBe('person@example.test person');
});

test('a configured git identity is never overridden', () => {
  git(['config', 'user.email', 'own@example.test']);
  git(['config', 'user.name', 'Own Name']);
  expect(shipCommit('person@example.test')).toBe(0);
  expect(git(['log', '-1', '--format=%ae %an']).stdout.trim()).toBe('own@example.test Own Name');
});

test('with no identity and no login email, the commit fails as before', () => {
  expect(shipCommit()).toBe(1);
});
