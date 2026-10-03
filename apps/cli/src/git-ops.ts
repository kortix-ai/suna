import { type SpawnSyncReturns, spawnSync } from 'node:child_process';

import type { Auth } from './api/auth.ts';
import { type ApiClient, ApiError } from './api/client.ts';
import type { AccountMembership, MeResponse, ProjectSummary } from './api/types.ts';
import { loadLocalManifest } from './manifest.ts';
import { type ProjectGitTarget, projectIsManaged } from './project-git.ts';
import { loadLink } from './project-link.ts';
import { confirm } from './prompts.ts';
import { C, status } from './style.ts';
import { selectFromList } from './tui-select.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Git plumbing for `kortix ship` — everything between "a project to push" and
// "a pushed branch": origin detection/healing, the commit step, the push (with
// its one proxy → upstream fallback), the push credential, and the GitHub
// import path. Also carries two ship-setup helpers that only exist to make a
// push possible — the first-ship account choice and the linked-project error
// explainer. `run` is the spawn helper both this module and ship's guards
// share. See project-git.ts for how a repo URL + credential mode resolve.
// ─────────────────────────────────────────────────────────────────────────────

interface GitTokenResponse {
  push_token: string;
  git_username?: string | null;
  repo_id: string;
  repo_url: string;
}

export function isGitHubUrl(url: string): boolean {
  return /(^https?:\/\/github\.com\/)|(^git@github\.com:)/i.test(url);
}

interface LinkRepoResponse {
  project: ProjectSummary;
}

/**
 * Link an existing GitHub repo to a new cloud project — the same import the
 * web UI does, from your terminal. Default path is the one-click GitHub App
 * install (no secret to manage): if the app isn't installed yet, we print the
 * install link, you authorize, and we retry. `--github-token <PAT>` skips the
 * app entirely (the App-free fallback — handy where the app can't be installed,
 * e.g. local dev whose callback points at prod).
 */
export async function linkGitHubBackedProject(
  client: ApiClient,
  opts: { repoUrl: string; name: string; accountId: string; githubToken?: string; yes: boolean },
): Promise<ProjectSummary> {
  const body = (token?: string) => ({
    repo_url: opts.repoUrl,
    name: opts.name,
    account_id: opts.accountId,
    ...(token ? { github_token: token } : {}),
  });

  // PAT path: one shot, no app needed.
  if (opts.githubToken) {
    const res = await client.post<LinkRepoResponse>(
      '/projects/link-repository',
      body(opts.githubToken),
    );
    return res.project;
  }

  // App path: retry around the one-click install.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await client.post<LinkRepoResponse>('/projects/link-repository', body());
      return res.project;
    } catch (err) {
      const installUrl =
        err instanceof ApiError && err.status === 409
          ? ((err.body as { install_url?: string } | null)?.install_url ?? null)
          : null;
      if (!installUrl) throw err;

      process.stdout.write(
        `\n  ${status.warn('Kortix GitHub App not installed for this repo yet.')}\n` +
          `  ${C.dim}One-click install (authorize access to your repo):${C.reset}\n` +
          `  ${C.cyan}${installUrl}${C.reset}\n\n` +
          `  ${C.dim}Or skip the app with a token: ${C.reset}${C.cyan}kortix ship --github-token <PAT>${C.reset}\n\n`,
      );
      if (opts.yes) {
        throw new Error(
          'GitHub App install required — re-run without -y after installing, or pass --github-token <PAT>.',
        );
      }
      const again = await confirm('Installed it? Retry the link', true);
      if (!again)
        throw new Error(
          'Aborted — install the Kortix GitHub App (or use --github-token) then run `kortix ship` again.',
        );
    }
  }
  throw new Error(
    'GitHub App still not detected after several tries — install it, or use --github-token <PAT>.',
  );
}

// ── git helpers ─────────────────────────────────────────────────────────────

/** The display name from kortix.yaml's project.name, if present. Lets a
 *  first ship honor the manifest instead of defaulting to the folder name. */
export function manifestProjectName(): string | undefined {
  try {
    const m = loadLocalManifest();
    const project = m?.data?.project as { name?: unknown } | undefined;
    const name = typeof project?.name === 'string' ? project.name.trim() : '';
    return name || undefined;
  } catch {
    return undefined;
  }
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
    process.stderr.write(
      `${status.err('git commit failed.')}\n${commit.stderr || commit.stdout}\n`,
    );
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
 * The push credential for a resolved git target. Through the proxy we
 * authenticate with our own Kortix token — the API resolves the upstream and
 * mints the host credential server-side, so no provider token is exported. A
 * proxy-less managed host pushes with a repo-scoped provider token: the one
 * the provision response carried when we have it, else a fresh /git-token
 * mint (never persisted in .git/config — and never a server-global PAT, which
 * the server refuses to export). BYO repos push with the user's own git
 * credentials.
 */
export async function resolvePushCredential(
  client: ApiClient,
  auth: Auth,
  projectId: string,
  target: ProjectGitTarget,
  provisioned?: { push_token: string | null; git_username?: string | null },
): Promise<{ pushToken: string | null; pushUsername: string }> {
  if (target.credentialMode === 'kortix-token') {
    return { pushToken: auth.token, pushUsername: 'x-access-token' };
  }
  if (target.credentialMode === 'managed-git-token') {
    if (provisioned?.push_token) {
      return {
        pushToken: provisioned.push_token,
        pushUsername: provisioned.git_username ?? 'x-access-token',
      };
    }
    const tok = await client.post<GitTokenResponse>(`/projects/${projectId}/git-token`);
    return { pushToken: tok.push_token, pushUsername: tok.git_username ?? 'x-access-token' };
  }
  return { pushToken: null, pushUsername: 'x-access-token' };
}

interface RunResult {
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

/**
 * When the linked project can't be fetched, explain *why* in terms of the
 * link — the common case is "you shipped under account A, then logged in as
 * account B that can't see it." Returns an exit code if it handled the error,
 * or null to let the generic handler take over.
 */
export function explainLinkedProjectError(
  err: unknown,
  projectId: string,
  auth: Auth,
): number | null {
  if (!(err instanceof ApiError)) return null;
  const link = loadLink();
  const host = link?.host ?? 'default';

  if (err.status === 403) {
    const linkedAccount = link?.account_id
      ? ` ${C.faded}(account ${link.account_id.slice(0, 8)})${C.reset}`
      : '';
    process.stderr.write(
      `\n${status.err("This folder is linked to a project on an account you can't access.")}\n` +
        `  ${C.dim}linked project ${C.reset}${projectId}${linkedAccount}\n` +
        `  ${C.dim}logged in as   ${C.reset}account ${auth.account_id.slice(0, 8)} ${C.faded}(host "${host}")${C.reset} — no access to that account\n\n` +
        `  ${C.dim}The link lives in ${C.reset}.kortix/link.json${C.dim}. Fix it one way:${C.reset}\n` +
        `    ${C.dim}• Log in with the account that has access:${C.reset}  ${C.cyan}kortix logout && kortix login${C.reset}\n` +
        `    ${C.dim}• Or get invited / granted access to that project, then retry.${C.reset}\n` +
        `    ${C.dim}• Or register this folder as a new project:${C.reset}  ${C.cyan}kortix projects unlink${C.reset}${C.dim} then ${C.reset}${C.cyan}kortix ship${C.reset}\n\n`,
    );
    return 1;
  }

  if (err.status === 404) {
    process.stderr.write(
      `\n${status.err('The linked project no longer exists (or was archived).')}\n` +
        `  ${C.dim}linked project ${C.reset}${projectId} ${C.faded}(host "${host}")${C.reset}\n\n` +
        `  ${C.dim}Re-point this folder:${C.reset}\n` +
        `    ${C.dim}• New project under your account:${C.reset}  ${C.cyan}kortix projects unlink${C.reset}${C.dim} then ${C.reset}${C.cyan}kortix ship${C.reset}\n` +
        `    ${C.dim}• Existing project:${C.reset}  ${C.cyan}kortix projects link <id>${C.reset}\n\n`,
    );
    return 1;
  }

  return null;
}

/**
 * Resolve which account a new project should belong to:
 *   --account flag (id or slug) → exact match
 *   single account               → that one
 *   multiple accounts            → prompt (unless -y / non-interactive / dry-run,
 *                                  which fall back to the active account)
 */
export async function resolveShipAccount(
  client: ApiClient,
  auth: Auth,
  flags: { account?: string; yes: boolean; dryRun: boolean },
): Promise<string> {
  let accounts: AccountMembership[] = [];
  try {
    accounts = (await client.get<MeResponse>('/accounts/me')).accounts ?? [];
  } catch {
    // Couldn't list accounts — fall back to the active one.
    return auth.account_id;
  }

  if (flags.account) {
    const match = accounts.find((a) => a.account_id === flags.account || a.slug === flags.account);
    if (!match) {
      const known = accounts.map((a) => a.slug).join(', ') || '(none)';
      throw new Error(`No account "${flags.account}" — you belong to: ${known}`);
    }
    return match.account_id;
  }

  if (accounts.length <= 1) return accounts[0]?.account_id ?? auth.account_id;

  // Multiple accounts: only prompt in an interactive run.
  if (flags.yes || flags.dryRun || process.stdout.isTTY !== true) {
    return auth.account_id;
  }
  const picked = await selectFromList<AccountMembership>({
    title: 'Ship to which account?',
    items: accounts.map((a) => ({
      value: a,
      label: a.name,
      sublabel: `${a.slug} · ${a.role}`,
    })),
  });
  if (!picked) throw new Error('No account selected.');
  return picked.account_id;
}
