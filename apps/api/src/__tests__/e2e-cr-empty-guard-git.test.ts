import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Importing src/projects/git/* into the test process trips the apps/api env
// validation under `bun test` — same constraint as the other git-transport
// e2e files, so this follows their harness: all src work happens in a
// `bun --eval` subprocess run from the repo root (see
// e2e-project-session-branch-git.test.ts).

let root = '';
let projectCounter = 0;

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function bunEval(script: string): string {
  return execFileSync('bun', ['--eval', script], {
    cwd: join(import.meta.dir, '..', '..', '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      KORTIX_GIT_CACHE_DIR: join(root, 'git-cache'),
    },
  }).trim();
}

function mergeModuleUrl(): string {
  return pathToFileURL(join(import.meta.dir, '..', 'projects', 'git', 'merge.ts')).href;
}

function makeFixture() {
  projectCounter += 1;
  const source = join(root, `source-${projectCounter}`);
  const origin = join(root, `origin-${projectCounter}.git`);
  mkdirSync(source, { recursive: true });
  git(['init', '-b', 'main'], source);
  git(['config', 'user.email', 'e2e@kortix.test'], source);
  git(['config', 'user.name', 'Kortix E2E'], source);
  writeFileSync(join(source, 'README.md'), '# test repo\n', 'utf8');
  git(['add', 'README.md'], source);
  git(['commit', '-m', 'initial'], source);
  git(['-c', 'init.defaultBranch=main', 'init', '--bare', origin]);
  git(['remote', 'add', 'origin', origin], source);
  git(['push', '--quiet', 'origin', 'main'], source);
  // The platform creates every session branch at base tip on session boot —
  // reproduce that: the branch EXISTS remotely, pointing at main's tip.
  git(['push', '--quiet', 'origin', 'main:session-branch'], source);
  const project = {
    projectId: `00000000-0000-4000-a000-${String(projectCounter).padStart(12, '0')}`,
    repoUrl: origin,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    // A present token makes ensureMirrorAuthToken return early instead of
    // dynamic-importing ../lib/git (which drags in the full env-validated
    // config and process.exits outside a configured environment). Local
    // file:// clones ignore the auth header entirely.
    gitAuthToken: 'e2e-local-token',
  };
  return { source, origin, project };
}

function resolveAheadState(project: unknown): { ahead: boolean; baseSha: string; headSha: string } {
  return JSON.parse(
    bunEval(`
      const { resolveBranchAheadState } = await import(${JSON.stringify(mergeModuleUrl())});
      const state = await resolveBranchAheadState(${JSON.stringify(project)}, 'main', 'session-branch');
      process.stdout.write(JSON.stringify(state));
    `),
  );
}

function commitOnSessionBranch(source: string, name: string) {
  git(['checkout', '-B', 'session-branch', 'origin/session-branch'], source);
  writeFileSync(join(source, name), `${name}\n`, 'utf8');
  git(['add', name], source);
  git(['commit', '-m', `add ${name}`], source);
  git(['push', '--quiet', 'origin', 'session-branch'], source);
}

describe('resolveBranchAheadState — the empty-CR guard', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kortix-cr-empty-guard-'));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('committed-but-never-pushed session branch (head tip == base tip) is not ahead', () => {
    const { project } = makeFixture();
    const state = resolveAheadState(project);
    expect(state.ahead).toBe(false);
    expect(state.headSha).toBe(state.baseSha);
  });

  test('a pushed commit on the session branch is ahead', () => {
    const { source, project } = makeFixture();
    commitOnSessionBranch(source, 'work.txt');
    const state = resolveAheadState(project);
    expect(state.ahead).toBe(true);
    expect(state.headSha).not.toBe(state.baseSha);
  });

  test('a push landing AFTER the mirror warmed in the same process is still seen (forced re-fetch beats the staleness window)', () => {
    const { source, origin, project } = makeFixture();
    // One process: warm the mirror with the branch empty, push from a second
    // clone while the in-process refresh marker is fresh, resolve again —
    // exactly an agent's `git push && kortix cr open` against a warm mirror.
    const result = JSON.parse(
      bunEval(`
        const { execFileSync } = await import('node:child_process');
        const { resolveBranchAheadState } = await import(${JSON.stringify(mergeModuleUrl())});
        const project = ${JSON.stringify(project)};
        const before = await resolveBranchAheadState(project, 'main', 'session-branch');
        const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
        run(['checkout', '-B', 'session-branch', 'origin/session-branch'], ${JSON.stringify(source)});
        await (await import('node:fs/promises')).writeFile(${JSON.stringify(join(source, 'late-push.txt'))}, 'late\\n');
        run(['add', 'late-push.txt'], ${JSON.stringify(source)});
        run(['commit', '-m', 'late push'], ${JSON.stringify(source)});
        run(['push', '--quiet', 'origin', 'session-branch'], ${JSON.stringify(source)});
        const after = await resolveBranchAheadState(project, 'main', 'session-branch');
        process.stdout.write(JSON.stringify({ before: before.ahead, after: after.ahead }));
      `),
    );
    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
  });

  test('a stale branch strictly behind an advanced base (merge-base == head) is not ahead', () => {
    const { source, project } = makeFixture();
    git(['checkout', 'main'], source);
    writeFileSync(join(source, 'main-moved.txt'), 'x\n', 'utf8');
    git(['add', 'main-moved.txt'], source);
    git(['commit', '-m', 'main advances'], source);
    git(['push', '--quiet', 'origin', 'main'], source);
    const state = resolveAheadState(project);
    expect(state.ahead).toBe(false);
    expect(state.headSha).not.toBe(state.baseSha);
  });

  test('diverged branch (both sides moved) still counts as ahead — conflicts are the merge gate’s job, not this one’s', () => {
    const { source, project } = makeFixture();
    commitOnSessionBranch(source, 'session-work.txt');
    git(['checkout', 'main'], source);
    writeFileSync(join(source, 'main-work.txt'), 'y\n', 'utf8');
    git(['add', 'main-work.txt'], source);
    git(['commit', '-m', 'main also advances'], source);
    git(['push', '--quiet', 'origin', 'main'], source);
    const state = resolveAheadState(project);
    expect(state.ahead).toBe(true);
  });
});
