import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { basename } from 'node:path';

import { loadAuth, loadAuthForHost, type Auth } from '../api/auth.ts';
import { activeHostName } from '../api/config.ts';
import { ApiError, clientFromAuth, type ApiClient } from '../api/client.ts';
import { isKortixProject, loadLink, saveLink, resolveProjectId } from '../project-link.ts';
import { takeFlagValue, takeFlagBool } from '../command-helpers.ts';
import { selectFromList } from '../tui-select.ts';
import { C, status } from '../style.ts';
import type { ProjectSummary, MeResponse, AccountMembership } from '../api/types.ts';

const HELP = `Usage: kortix ship [options]

Stage everything, commit, and push your current branch to the project's git
repo — in one command. Run it once to create the project, then run it again
any time to sync. It's the everyday "save my work to the cloud" command.

Every run:
  1. git add -A + commit   (skipped if nothing changed)
  2. push the branch you're on → the same-named branch on the project's repo

First ship vs. after:
  * First ship   creates the cloud project + a git repo, links this folder
                 (.kortix/link.json), then pushes.
  * Every ship   after that sees the link, skips setup, and just commits +
                 pushes. Continuous by design — re-run as often as you like.
                 The link travels in .kortix/link.json, so a teammate who
                 clones a linked repo can \`kortix ship\` from it too.

Branches:
  Ship pushes whatever branch you're on to the matching remote branch — on
  \`main\` it pushes main; checked out on a \`feature\` branch, it pushes feature.

Where it pushes (origin is inferred, never asked):
  * Existing \`origin\` remote (e.g. your own GitHub repo) → pushes there with
    your own git credentials. Bring-your-own works continuously, same as below.
  * No \`origin\` remote                                    → creates a managed
    Kortix git repo (hosted on Freestyle) and pushes to it. No GitHub needed.

Accounts:
  On first ship, if you belong to more than one account you're asked which to
  create the project under (skip with --account or -y). No snapshot builds.

Options:
  --name <project>     Display name for a new project (default: folder name).
  --account <id|slug>  Account to create the project under (first ship only).
  --origin <value>     Override origin choice:
                         freestyle    force a managed Kortix repo
                         <git-url>    register + push to this remote
  -m, --message <msg>  Commit message for the sync (default: "kortix: ship").
  --no-commit          Don't commit. Fail if the working tree is dirty.
  -y, --yes            Don't prompt; use the active account.
  -n, --dry-run        Print what would happen, do nothing.
  --project <id>       Operate on this project id (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  -h, --help           Show this help.
`;

interface ShipFlags {
  name?: string;
  account?: string;
  origin?: string;
  message?: string;
  noCommit: boolean;
  yes: boolean;
  dryRun: boolean;
  project?: string;
  host?: string;
  help: boolean;
}

interface ProvisionResponse extends ProjectSummary {
  push_token: string;
  repo_id: string;
}

interface GitTokenResponse {
  push_token: string;
  repo_id: string;
  repo_url: string;
}

export async function runShip(argv: string[]): Promise<number> {
  let flags: ShipFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // ── Guards ───────────────────────────────────────────────────────────────
  if (!isKortixProject()) {
    process.stderr.write(
      `${status.err(`Not a Kortix project — no .kortix/ or kortix.toml in ${process.cwd()}.`)}\n` +
        `  ${C.dim}Run ${C.reset}${C.cyan}kortix init${C.reset}${C.dim} here first.${C.reset}\n`,
    );
    return 1;
  }
  if (!run('git', ['rev-parse', '--is-inside-work-tree']).ok) {
    process.stderr.write(
      `${status.err('Not inside a git repository.')}\n` +
        `  ${C.dim}Run ${C.reset}${C.cyan}kortix init${C.reset}${C.dim} (it runs git init for you).${C.reset}\n`,
    );
    return 1;
  }

  // ── Auth (host: --host → link.json → active) ──────────────────────────────
  const hostFromLink = !flags.host ? loadLink()?.host : undefined;
  const hostName = flags.host ?? hostFromLink;
  const auth = hostName ? loadAuthForHost(hostName) : loadAuth();
  if (!auth?.token) {
    if (hostName) {
      process.stderr.write(
        `${status.err(`Host "${hostName}" is not logged in.`)} Run ` +
          `${C.cyan}kortix login --host ${hostName}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in.')} Run ${C.cyan}kortix login${C.reset}.\n`);
    }
    return 1;
  }
  const client = clientFromAuth(auth);

  // ── Resolve state: already linked (sync) vs first ship (create) ───────────
  const linkedId = resolveProjectId(flags.project);
  try {
    if (linkedId) {
      return await shipExisting(client, auth, linkedId, flags);
    }
    return await shipFirstTime(client, auth, hostName, flags);
  } catch (err) {
    return surface(err);
  }
}

// ── First ship: create the cloud project, wire the remote, push ─────────────
async function shipFirstTime(
  client: ApiClient,
  auth: Auth,
  hostName: string | undefined,
  flags: ShipFlags,
): Promise<number> {
  const name = flags.name ?? basename(process.cwd());

  // Which account owns the new project? Ask when there's a real choice.
  const accountId = await resolveShipAccount(client, auth, flags);

  // Decide origin without asking: explicit flag → existing remote → managed.
  const explicitUrl =
    flags.origin && flags.origin !== 'freestyle' && flags.origin !== 'github'
      ? flags.origin
      : null;
  const forceManaged = flags.origin === 'freestyle';
  const existingOrigin = forceManaged ? null : detectOrigin();
  const byoUrl = explicitUrl ?? existingOrigin;

  let project: ProjectSummary;
  let repoUrl: string;
  let pushToken: string | null = null;

  if (byoUrl) {
    process.stdout.write(
      `\n  ${C.bold}kortix ship${C.reset}  ${C.dim}new project → your git${C.reset}\n` +
        `  ${C.dim}origin  ${C.reset}${byoUrl}\n\n`,
    );
    if (flags.dryRun) {
      process.stdout.write(
        `  ${C.dim}[dry-run] would: POST /projects {repo_url:"${byoUrl}", name:"${name}"} + push${C.reset}\n\n`,
      );
      return 0;
    }
    project = await client.post<ProjectSummary>('/projects', {
      repo_url: byoUrl,
      name,
      account_id: accountId,
    });
    repoUrl = project.repo_url;
    // Only touch the remote when the user named one explicitly — an existing
    // `origin` is left exactly as-is so their credential setup keeps working.
    if (explicitUrl) setOrigin(explicitUrl);
  } else {
    process.stdout.write(
      `\n  ${C.bold}kortix ship${C.reset}  ${C.dim}new project → managed Kortix git${C.reset}\n` +
        `  ${C.dim}name    ${C.reset}${name}\n\n`,
    );
    if (flags.dryRun) {
      process.stdout.write(
        `  ${C.dim}[dry-run] would: POST /projects/provision {name:"${name}"}, set origin, push${C.reset}\n\n`,
      );
      return 0;
    }
    const prov = await client.post<ProvisionResponse>('/projects/provision', {
      name,
      account_id: accountId,
    });
    project = prov;
    repoUrl = prov.repo_url;
    pushToken = prov.push_token;
    setOrigin(repoUrl);
  }

  saveLink({
    project_id: project.project_id,
    account_id: project.account_id,
    host: hostName ?? activeHostName() ?? 'default',
    host_url: auth.api_base,
    linked_at: new Date().toISOString(),
  });

  const committed = commitIfNeeded(flags);
  if (committed === 'error') return 1;

  const pushed = pushCurrentBranch(repoUrl, pushToken);
  if (!pushed) return 1;

  reportShipped(auth, project, repoUrl);
  return 0;
}

// ── Subsequent ship: commit + push to the linked project ────────────────────
async function shipExisting(
  client: ApiClient,
  auth: Auth,
  projectId: string,
  flags: ShipFlags,
): Promise<number> {
  let project: ProjectSummary;
  try {
    project = await client.get<ProjectSummary>(`/projects/${projectId}`);
  } catch (err) {
    const handled = explainLinkedProjectError(err, projectId, auth);
    if (handled !== null) return handled;
    throw err;
  }
  const repoUrl = project.repo_url;
  const meta = (project.metadata ?? {}) as Record<string, any>;
  // Canonical: metadata.git.{provider,auth.method}. Fallback: legacy git_provider.
  const git = meta.git as { provider?: string; auth?: { method?: string } } | undefined;
  const managed = git
    ? git.provider === 'freestyle' && (git.auth?.method ?? 'managed') === 'managed'
    : meta.git_provider === 'freestyle';

  process.stdout.write(
    `\n  ${C.bold}kortix ship${C.reset}  ${C.dim}sync${C.reset}\n` +
      `  ${C.dim}project ${C.reset}${project.name} ${C.faded}(${project.project_id})${C.reset}\n` +
      `  ${C.dim}branch  ${C.reset}${currentBranch()}\n\n`,
  );

  if (flags.dryRun) {
    process.stdout.write(
      `  ${C.dim}[dry-run] would: ${managed ? 'mint push token, ' : ''}commit + push to ${repoUrl}${C.reset}\n\n`,
    );
    return 0;
  }

  // Managed repos get a fresh, scoped, write-only token per ship — we never
  // persist credentials in .git/config.
  let pushToken: string | null = null;
  if (managed) {
    const tok = await client.post<GitTokenResponse>(`/projects/${projectId}/git-token`);
    pushToken = tok.push_token;
  }
  // BYO repos may have lost their remote (fresh clone of a linked repo); heal it.
  ensureOrigin(repoUrl);

  const committed = commitIfNeeded(flags);
  if (committed === 'error') return 1;

  const pushed = pushCurrentBranch(repoUrl, pushToken);
  if (!pushed) return 1;

  reportShipped(auth, project, repoUrl);
  return 0;
}

// ── git helpers ─────────────────────────────────────────────────────────────

function detectOrigin(): string | null {
  const r = run('git', ['remote', 'get-url', 'origin']);
  const url = r.stdout.trim();
  return r.ok && url ? url : null;
}

function setOrigin(url: string): void {
  if (detectOrigin()) {
    run('git', ['remote', 'set-url', 'origin', url]);
  } else {
    run('git', ['remote', 'add', 'origin', url]);
  }
}

/** Add `origin` only if it's missing — don't clobber an existing remote. */
function ensureOrigin(url: string): void {
  if (!detectOrigin()) run('git', ['remote', 'add', 'origin', url]);
}

/** Returns 'ok' (committed or clean) or 'error'. */
function commitIfNeeded(flags: ShipFlags): 'ok' | 'error' {
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
function currentBranch(): string {
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
function pushCurrentBranch(repoUrl: string, pushToken: string | null): string | null {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (!branch || branch === 'HEAD') {
    process.stderr.write(
      `${status.err('Not on a branch (detached HEAD?) — check out a branch and retry.')}\n`,
    );
    return null;
  }
  const refspec = `${branch}:refs/heads/${branch}`;
  const args = pushToken ? [...authHeaderArgs(repoUrl, pushToken), 'push'] : ['push'];
  args.push('-u', 'origin', refspec);

  const push = run('git', args, { inheritStdio: true });
  if (!push.ok) {
    process.stderr.write(`\n${status.err(`git push failed (exit ${push.code}).`)}\n`);
    return null;
  }
  process.stdout.write(
    `\n${status.ok(`Pushed ${C.bold}${branch}${C.reset} → ${C.bold}origin/${branch}${C.reset}`)}\n`,
  );
  return branch;
}

/** `-c http.https://<host>/.extraheader=AUTHORIZATION: basic <b64>` — mirrors
 *  the backend's git auth scheme (projects/git.ts). */
function authHeaderArgs(repoUrl: string, token: string): string[] {
  let host = 'git.freestyle.sh';
  try {
    host = new URL(repoUrl).host;
  } catch {
    /* keep default */
  }
  const enc = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://${host}/.extraheader=AUTHORIZATION: basic ${enc}`];
}

function reportShipped(auth: Auth, project: ProjectSummary, repoUrl: string): void {
  // Prefer the server-provided dashboard URL; only fall back to guessing from
  // the API host for older backends that don't return one.
  const url = project.dashboard_url ?? `${webDashboardUrl(auth.api_base)}/projects/${project.project_id}`;
  process.stdout.write(
    `\n${status.ok(`Shipped ${C.bold}${project.name}${C.reset}`)}\n` +
      `  ${C.dim}repo  ${C.reset}${repoUrl}\n` +
      `  ${C.dim}live  ${C.reset}${C.cyan}${url}${C.reset}\n\n`,
  );
}

function webDashboardUrl(apiBase: string): string {
  try {
    const u = new URL(apiBase);
    if (u.hostname.startsWith('api.')) u.hostname = u.hostname.slice(4);
    return u.origin;
  } catch {
    return 'https://kortix.com';
  }
}

/**
 * Resolve which account a new project should belong to:
 *   --account flag (id or slug) → exact match
 *   single account               → that one
 *   multiple accounts            → prompt (unless -y / non-interactive / dry-run,
 *                                  which fall back to the active account)
 */
async function resolveShipAccount(
  client: ApiClient,
  auth: Auth,
  flags: ShipFlags,
): Promise<string> {
  let accounts: AccountMembership[] = [];
  try {
    accounts = (await client.get<MeResponse>('/accounts/me')).accounts ?? [];
  } catch {
    // Couldn't list accounts — fall back to the active one.
    return auth.account_id;
  }

  if (flags.account) {
    const match = accounts.find(
      (a) => a.account_id === flags.account || a.slug === flags.account,
    );
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
      label: `${a.name}${a.personal_account ? ' (personal)' : ''}`,
      sublabel: `${a.slug} · ${a.role}`,
    })),
  });
  if (!picked) throw new Error('No account selected.');
  return picked.account_id;
}

// ── plumbing ────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): ShipFlags {
  const rest = [...argv];
  const flags: ShipFlags = { noCommit: false, yes: false, dryRun: false, help: false };
  flags.name = takeFlagValue(rest, ['--name']);
  flags.account = takeFlagValue(rest, ['--account']);
  flags.origin = takeFlagValue(rest, ['--origin']);
  flags.message = takeFlagValue(rest, ['--message', '-m']);
  flags.project = takeFlagValue(rest, ['--project']);
  flags.host = takeFlagValue(rest, ['--host']);
  flags.noCommit = takeFlagBool(rest, ['--no-commit']);
  flags.yes = takeFlagBool(rest, ['-y', '--yes']);
  flags.dryRun = takeFlagBool(rest, ['-n', '--dry-run']);
  flags.help = takeFlagBool(rest, ['-h', '--help']);
  if (rest.length > 0) throw new Error(`kortix ship: unknown option "${rest[0]}"`);
  return flags;
}

/**
 * When the linked project can't be fetched, explain *why* in terms of the
 * link — the common case is "you shipped under account A, then logged in as
 * account B that can't see it." Returns an exit code if it handled the error,
 * or null to let the generic handler take over.
 */
function explainLinkedProjectError(err: unknown, projectId: string, auth: Auth): number | null {
  if (!(err instanceof ApiError)) return null;
  const link = loadLink();
  const host = link?.host ?? 'default';

  if (err.status === 403) {
    const linkedAccount = link?.account_id ? ` ${C.faded}(account ${link.account_id.slice(0, 8)})${C.reset}` : '';
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

function surface(err: unknown): number {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(`${status.err('Token rejected. Run `kortix login`.')}\n`);
    } else if (err.status === 503) {
      process.stderr.write(
        `${status.err(err.message)}\n` +
          `  ${C.dim}Managed git isn't configured on this host. Pass ${C.reset}${C.cyan}--origin <git-url>${C.reset}${C.dim} to use your own remote.${C.reset}\n`,
      );
    } else {
      process.stderr.write(`${status.err(`HTTP ${err.status}: ${err.message}`)}\n`);
    }
    return 1;
  }
  process.stderr.write(`${status.err((err as Error).message)}\n`);
  return 1;
}

interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts?: { inheritStdio?: boolean }): RunResult {
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
