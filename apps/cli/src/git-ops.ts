/**
 * The git plumbing of the CLI — commit, branch, remote and push.
 *
 * ONE module: `kortix ship` used to hold these beside its orchestration, and
 * `kortix projects clone` imported the auth-header helper back out of it
 * (command-to-command). Keeping the push path in one place is what stops the
 * transport decisions from drifting — see project-git.ts for the credential
 * resolver every command shares.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { ApiClient } from './api/client.ts';
import type { Auth } from './api/auth.ts';
import type { ProjectSummary } from './api/types.ts';
import { projectIsManaged, type ProjectGitTarget } from './project-git.ts';
import { C, status } from './style.ts';

export interface GitTokenResponse {
  push_token: string;
  git_username?: string | null;
  repo_id: string;
  repo_url: string;
}

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts?: { inheritStdio?: boolean }): RunResult {
  let result: SpawnSyncReturns<Buffer | string>;
  if (opts?.inheritStdio) {
    result = spawnSync(cmd, args, { stdio: 'inherit' });
    return { ok: result.status === 0, code: result.status ?? 1, stdout: '', stderr: '' };
  }
  result = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    stdout: (result.stdout as string) ?? '',
    stderr: (result.stderr as string) ?? '',
  };
}

export function detectOrigin(): string | null {
  const r = run('git', ['remote', 'get-url', 'origin']);
  const url = r.stdout.trim();
  return r.ok && url ? url : null;
}

export function setOrigin(url: string): void {
  if (detectOrigin()) {
    run('git', ['remote', 'set-url', 'origin', url]);
  } else {
    run('git', ['remote', 'add', 'origin', url]);
  }
}

/** Add `origin` only if it's missing — don't clobber an existing remote. */
export function ensureOrigin(url: string): void {
  if (!detectOrigin()) run('git', ['remote', 'add', 'origin', url]);
}

/** Returns 'ok' (committed or clean) or 'error'. */
export function commitIfNeeded(flags: { noCommit: boolean; message?: string }): 'ok' | 'error' {
  const dirty =
    !run('git', ['diff', '--quiet']).ok || !run('git', ['diff', '--cached', '--quiet']).ok;
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard']);
  const hasUntracked = untracked.ok && untracked.stdout.trim().length > 0;
  const hasHead = run('git', ['rev-parse', '--verify', 'HEAD']).ok;

  if (!dirty && !hasUntracked && hasHead) {
    process.stdout.write(`  ${C.dim}clean working tree${C.reset}\n`);
    return 'ok';
  }
  if (flags.noCommit) {
    process.stderr.write(
      `${status.err('Working tree is dirty and --no-commit was passed.')}\n` +
        `  ${C.dim}Commit or stash first.${C.reset}\n`,
    );
    return 'error';
  }
  const msg = flags.message ?? 'kortix: ship';
  const add = run('git', ['add', '-A']);
  if (!add.ok) {
    const detail = (add.stderr || add.stdout).trim();
    process.stderr.write(`${status.err('git add -A failed.')}\n`);
    if (detail) {
      process.stderr.write(`  ${C.dim}${detail.split('\n').join('\n  ')}${C.reset}\n`);
    }
    if (/index\.lock/i.test(detail)) {
      process.stderr.write(
        `  ${C.dim}A stale git lock is blocking it. If no other git process is running here, remove it and retry:${C.reset}\n` +
          `    ${C.cyan}rm -f .git/index.lock${C.reset}\n`,
      );
    }
    return 'error';
  }
  const commit = run('git', ['commit', '-m', msg]);
  if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    process.stderr.write(`${status.err('git commit failed.')}\n${commit.stderr || commit.stdout}\n`);
    return 'error';
  }
  if (commit.ok) process.stdout.write(`${status.ok(`Committed: ${C.bold}${msg}${C.reset}`)}\n`);
  return 'ok';
}

/** Current branch name, robust to unborn branches (fresh `git init`). */
export function currentBranch(): string {
  const sym = run('git', ['symbolic-ref', '--short', 'HEAD']);
  if (sym.ok && sym.stdout.trim()) return sym.stdout.trim();
  const ref = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  return ref && ref !== 'HEAD' ? ref : 'main';
}

/**
 * Push the *current* branch to the same-named branch on origin — so whatever
 * branch you're on (main, a feature branch, a test branch) goes to the
 * matching remote branch. For managed repos we inject the scoped token via an
 * http.extraHeader so it never lands in .git/config; for BYO repos we rely on
 * the user's own git credentials. Returns the pushed branch, or null on error.
 */
function pushCurrentBranch(
  repoUrl: string,
  pushToken: string | null,
  gitUsername = 'x-access-token',
  opts: { quietOnFailure?: boolean } = {},
): string | null {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (!branch || branch === 'HEAD') {
    process.stderr.write(
      `${status.err('Not on a branch (detached HEAD?) — check out a branch and retry.')}\n`,
    );
    return null;
  }
  const refspec = `${branch}:refs/heads/${branch}`;
  const args = pushToken ? [...authHeaderArgs(repoUrl, pushToken, gitUsername), 'push'] : ['push'];
  args.push('-u', 'origin', refspec);

  const push = run('git', args, { inheritStdio: true });
  if (!push.ok) {
    if (!opts.quietOnFailure) {
      process.stderr.write(`\n${status.err(`git push failed (exit ${push.code}).`)}\n`);
    }
    return null;
  }
  process.stdout.write(
    `\n${status.ok(`Pushed ${C.bold}${branch}${C.reset} → ${C.bold}origin/${branch}${C.reset}`)}\n`,
  );
  return branch;
}

/**
 * Push the current branch, with ONE fallback transport.
 *
 * The proxy origin is the right default — it works whatever a host's managed
 * git is configured with, and no provider credential ever reaches the client.
 * But the CLI talks to hosts it wasn't shipped with: an older API authorizes
 * the proxy on ACCOUNT OWNERSHIP alone, so a token bound to a different account
 * of the same user is refused there while POST /git-token (which gates on the
 * per-project `gitops.push` capability) would still serve it. So when a proxy
 * push fails on a managed repo, retry once against the raw upstream with a
 * minted repo-scoped token before giving up: either transport being unavailable
 * is survivable, only both failing is a real error. Returns the branch, or null.
 */
export async function pushProjectBranch(
  client: ApiClient,
  project: ProjectSummary,
  target: ProjectGitTarget,
  pushToken: string | null,
  pushUsername: string,
): Promise<string | null> {
  const canRetry = target.credentialMode === 'kortix-token' && projectIsManaged(project);
  const pushed = pushCurrentBranch(target.repoUrl, pushToken, pushUsername, {
    quietOnFailure: canRetry,
  });
  if (pushed || !canRetry) return pushed;

  let minted: GitTokenResponse;
  try {
    minted = await client.post<GitTokenResponse>(`/projects/${project.project_id}/git-token`);
  } catch {
    // No second transport available — report the push failure we swallowed.
    process.stderr.write(`\n${status.err('git push failed.')}\n`);
    return null;
  }
  process.stdout.write(
    `  ${status.warn('Proxy push rejected — retrying against the managed upstream.')}\n`,
  );
  const upstreamUrl = minted.repo_url || project.repo_url;
  setOrigin(upstreamUrl);
  return pushCurrentBranch(upstreamUrl, minted.push_token, minted.git_username || pushUsername);
}

/** `-c http.<scheme>://<host>/.extraheader=AUTHORIZATION: basic <b64>` —
 *  mirrors the backend's git auth scheme (projects/git.ts). The extraheader
 *  key MUST carry the remote's actual scheme (http for a localhost proxy,
 *  https in prod) or git won't apply it (scheme-scoped config). */
export function authHeaderArgs(
  repoUrl: string,
  token: string,
  gitUsername = 'x-access-token',
): string[] {
  let origin = 'https://github.com';
  try {
    const u = new URL(repoUrl);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    /* keep default */
  }
  const enc = Buffer.from(`${gitUsername}:${token}`).toString('base64');
  // RFC 7617 treats the auth scheme case-insensitively, but Code Storage's
  // Git endpoint currently requires the canonical `Basic` spelling.
  return ['-c', `http.${origin}/.extraheader=Authorization: Basic ${enc}`];
}

/**
 * The credential a ship push presents: our own Kortix token through the git
 * proxy, else the provision response's repo-scoped token, else a fresh mint
 * from POST /git-token (never persisted in .git/config). A BYO remote takes
 * no token at all — the user's own git credentials push.
 */
export async function resolvePushCredential(
  client: ApiClient,
  auth: Auth,
  target: ProjectGitTarget,
  projectId: string,
  provisioned?: { push_token: string | null; git_username?: string | null },
): Promise<{ pushToken: string | null; pushUsername: string }> {
  let pushToken: string | null = null;
  let pushUsername = 'x-access-token';
  if (target.credentialMode === 'kortix-token') {
    pushToken = auth.token;
  } else if (provisioned) {
    pushToken = provisioned.push_token;
    pushUsername = provisioned.git_username ?? pushUsername;
  }
  if (!pushToken && target.credentialMode !== 'none') {
    const tok = await client.post<GitTokenResponse>(`/projects/${projectId}/git-token`);
    pushToken = tok.push_token;
    pushUsername = tok.git_username ?? pushUsername;
  }
  return { pushToken, pushUsername };
}
