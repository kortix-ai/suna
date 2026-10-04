import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

// Async on purpose: a synchronous spawn inside a parallel `bun test` worker can
// miss the child's exit on macOS and spin the worker at 100% CPU forever (the
// child is left <defunct>). Awaiting `exited` never blocks the worker's loop.
async function run(cmd: string[], cwd: string | undefined, env: Record<string, string | undefined>): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}: ${err}`);
  return out.trim();
}

function git(args: string[], cwd?: string): Promise<string> {
  return run(['git', ...args], cwd, { ...process.env, GIT_TERMINAL_PROMPT: '0' });
}

function bunEval(script: string): Promise<string> {
  return run(['bun', '--eval', script], join(import.meta.dir, '..', '..', '..', '..'), {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    KORTIX_GIT_CACHE_DIR: join(root, 'git-cache'),
  });
}

function mergeModuleUrl(): string {
  return pathToFileURL(join(import.meta.dir, '..', 'services', 'git', 'merge.ts')).href;
}

function commitsModuleUrl(): string {
  return pathToFileURL(join(import.meta.dir, '..', 'services', 'git', 'commits.ts')).href;
}

async function makeFixture() {
  projectCounter += 1;
  const source = join(root, `source-${projectCounter}`);
  const origin = join(root, `origin-${projectCounter}.git`);
  mkdirSync(source, { recursive: true });
  await git(['init', '-b', 'main'], source);
  await git(['config', 'user.email', 'e2e@kortix.test'], source);
  await git(['config', 'user.name', 'Kortix E2E'], source);
  writeFileSync(join(source, 'README.md'), '# test repo\n', 'utf8');
  await git(['add', 'README.md'], source);
  await git(['commit', '-m', 'initial'], source);
  await git(['-c', 'init.defaultBranch=main', 'init', '--bare', origin]);
  await git(['remote', 'add', 'origin', origin], source);
  await git(['push', '--quiet', 'origin', 'main'], source);
  // The platform creates every session branch at base tip on session boot —
  // reproduce that: the branch EXISTS remotely, pointing at main's tip.
  await git(['push', '--quiet', 'origin', 'main:session-branch'], source);
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

async function resolveAheadState(project: unknown): Promise<{ ahead: boolean; baseSha: string; headSha: string }> {
  return JSON.parse(
    await bunEval(`
      const { resolveBranchAheadState } = await import(${JSON.stringify(mergeModuleUrl())});
      const state = await resolveBranchAheadState(${JSON.stringify(project)}, 'main', 'session-branch');
      process.stdout.write(JSON.stringify(state));
    `),
  );
}

async function commitOnSessionBranch(source: string, name: string) {
  await git(['checkout', '-B', 'session-branch', 'origin/session-branch'], source);
  writeFileSync(join(source, name), `${name}\n`, 'utf8');
  await git(['add', name], source);
  await git(['commit', '-m', `add ${name}`], source);
  await git(['push', '--quiet', 'origin', 'session-branch'], source);
}

describe('resolveBranchAheadState — the empty-CR guard', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kortix-cr-empty-guard-'));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('committed-but-never-pushed session branch (head tip == base tip) is not ahead', async () => {
    const { project } = await makeFixture();
    const state = await resolveAheadState(project);
    expect(state.ahead).toBe(false);
    expect(state.headSha).toBe(state.baseSha);
  });

  test('a pushed commit on the session branch is ahead', async () => {
    const { source, project } = await makeFixture();
    await commitOnSessionBranch(source, 'work.txt');
    const state = await resolveAheadState(project);
    expect(state.ahead).toBe(true);
    expect(state.headSha).not.toBe(state.baseSha);
  });

  test('a push landing AFTER the mirror warmed in the same process is still seen (forced re-fetch beats the staleness window)', async () => {
    const { source, origin, project } = await makeFixture();
    // One process: warm the mirror with the branch empty, push from a second
    // clone while the in-process refresh marker is fresh, resolve again —
    // exactly an agent's `git push && kortix cr open` against a warm mirror.
    const result = JSON.parse(
      await bunEval(`
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

  test('a branch created AFTER the mirror warmed is resolved after one forced re-fetch', async () => {
    const { source, project } = await makeFixture();
    await git(['push', '--quiet', 'origin', '--delete', 'session-branch'], source);

    const result = JSON.parse(
      await bunEval(`
        const { execFileSync } = await import('node:child_process');
        const { resolveCommitSha } = await import(${JSON.stringify(commitsModuleUrl())});
        const { resolveBranchAheadState } = await import(${JSON.stringify(mergeModuleUrl())});
        const project = ${JSON.stringify(project)};
        await resolveCommitSha(project, 'main');
        const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
        run(['checkout', '-B', 'session-branch', 'main'], ${JSON.stringify(source)});
        await (await import('node:fs/promises')).writeFile(${JSON.stringify(join(source, 'new-branch.txt'))}, 'new branch\\n');
        run(['add', 'new-branch.txt'], ${JSON.stringify(source)});
        run(['commit', '-m', 'create session branch'], ${JSON.stringify(source)});
        run(['push', '--quiet', 'origin', 'session-branch'], ${JSON.stringify(source)});
        const state = await resolveBranchAheadState(project, 'main', 'session-branch');
        process.stdout.write(JSON.stringify(state));
      `),
    );

    expect(result.ahead).toBe(true);
    expect(result.headSha).not.toBe(result.baseSha);
  });

  test('a stale branch strictly behind an advanced base (merge-base == head) is not ahead', async () => {
    const { source, project } = await makeFixture();
    await git(['checkout', 'main'], source);
    writeFileSync(join(source, 'main-moved.txt'), 'x\n', 'utf8');
    await git(['add', 'main-moved.txt'], source);
    await git(['commit', '-m', 'main advances'], source);
    await git(['push', '--quiet', 'origin', 'main'], source);
    const state = await resolveAheadState(project);
    expect(state.ahead).toBe(false);
    expect(state.headSha).not.toBe(state.baseSha);
  });

  test('diverged branch (both sides moved) still counts as ahead — conflicts are the merge gate’s job, not this one’s', async () => {
    const { source, project } = await makeFixture();
    await commitOnSessionBranch(source, 'session-work.txt');
    await git(['checkout', 'main'], source);
    writeFileSync(join(source, 'main-work.txt'), 'y\n', 'utf8');
    await git(['add', 'main-work.txt'], source);
    await git(['commit', '-m', 'main also advances'], source);
    await git(['push', '--quiet', 'origin', 'main'], source);
    const state = await resolveAheadState(project);
    expect(state.ahead).toBe(true);
  });
});
