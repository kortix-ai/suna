import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { basename } from 'node:path';

import { loadAuth, loadAuthForHost, type Auth } from '../api/auth.ts';
import { activeHostName, hasEnvTokenHost } from '../api/config.ts';
import { ApiError, clientFromAuth, type ApiClient } from '../api/client.ts';
import { isKortixWorkspace, loadWorkspaceLink, saveWorkspaceLink, resolveWorkspaceId } from '../workspace-link.ts';
import { takeFlagValue, takeFlagBool } from '../command-helpers.ts';
import { selectFromList } from '../tui-select.ts';
import { confirm, prompt, promptSecret } from '../prompts.ts';
import { loadLocalManifest, lintManifest, type EnvSpec, type LocalManifest } from '../manifest.ts';
import {
  configureWorkspaceGitAuth,
  workspaceIsManaged,
  resolveWorkspaceGitTarget,
  type WorkspaceGitTarget,
} from '../workspace-git.ts';
import { C, help, status } from '../style.ts';
import { workspaceWebUrl } from '../web-url.ts';
import type {
  WorkspaceSummary,
  MeResponse,
  AccountMembership,
  WorkspaceSecretsResponse,
} from '../api/types.ts';

const HELP = help`Usage: kortix ship [options]

Stage everything, commit, and push your current branch to the workspace's git
repo — in one command. Run it once to create the workspace, then run it again
any time to sync. It's the everyday "save my work to the cloud" command.

Every run:
  1. verify kortix.yaml parses + validates   (skip with --no-verify)
  2. git add -A + commit                      (skipped if nothing changed)
  3. offer to set any [env] secret not yet set (prompts you; skip with --no-env)
  4. push the branch you're on → the same-named branch on the workspace's repo
  5. connect any declared connector that still needs auth   (skip with --no-connect)

First ship vs. after:
  * First ship   creates the cloud workspace + a git repo, links this folder
                 (.kortix/link.json), then pushes.
  * Every ship   after that sees the link, skips setup, and just commits +
                 pushes. Continuous by design — re-run as often as you like.
                 The link travels in .kortix/link.json, so a teammate who
                 clones a linked repo can \`kortix ship\` from it too.

Branches:
  Ship pushes whatever branch you're on to the matching remote branch — on
  \`main\` it pushes main; checked out on a \`feature\` branch, it pushes feature.

Where it backs the workspace (origin is inferred, never asked):
  * Existing GitHub \`origin\` (e.g. github.com/you/repo) → links it directly,
    GitHub-backed. If the Kortix GitHub App isn't installed yet, ship prints a
    one-click install link (same as the web UI import); or pass
    --github-token <PAT> to link without the app. Sessions clone/push the real
    repo, so \`git push\` stays synced.
  * Other existing \`origin\` remote                       → registered + pushed.
  * No \`origin\` remote                                    → creates a managed
    Kortix git repo and pushes to it. No GitHub needed.

Accounts:
  On first ship, if you belong to more than one account you're asked which to
  create the workspace under (skip with --account or -y). No snapshot builds.

Options:
  --name <workspace>     Display name for a new workspace (default: folder name).
  --account <id|slug>  Account to create the workspace under (first ship only).
  --origin <value>     Override origin choice:
                         managed      force a managed Kortix repo
                         <git-url>    register + push to this remote
  --github-token <pat> Link a GitHub origin with this token instead of the
                       GitHub App (App-free import; needs repo Contents R/W).
  -m, --message <msg>  Commit message for the sync (default: "kortix: ship").
  --no-commit          Don't commit. Fail if the working tree is dirty.
  --no-verify          Skip the kortix.yaml validation (compile) check.
  --no-env             Skip the [env] secret check + prompts.
  --no-connect         Skip the connector connect/credential prompts.
  -y, --yes            Don't prompt; use the active account, skip secret prompts.
  -n, --dry-run        Print what would happen, do nothing.
  --workspace <id>       Operate on this workspace id (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  -h, --help           Show this help.
`;

interface ShipFlags {
  name?: string;
  account?: string;
  origin?: string;
  githubToken?: string;
  message?: string;
  noCommit: boolean;
  noVerify: boolean;
  noEnv: boolean;
  noConnect: boolean;
  yes: boolean;
  dryRun: boolean;
  workspace?: string;
  host?: string;
  help: boolean;
}

interface ProvisionResponse extends WorkspaceSummary {
  push_token: string | null;
  git_username?: string | null;
  repo_id: string;
}

interface GitTokenResponse {
  push_token: string;
  git_username?: string | null;
  repo_id: string;
  repo_url: string;
}

/** Both ship paths use the shared resolver (see ../workspace-git.ts) so ship,
 *  clone, and the git credential helper can never disagree about how to reach
 *  a workspace's repo again. */
export function resolveProvisionShipGitTarget(workspace: ProvisionResponse): WorkspaceGitTarget {
  return resolveWorkspaceGitTarget(workspace);
}

export function resolveExistingShipGitTarget(workspace: WorkspaceSummary): WorkspaceGitTarget {
  return resolveWorkspaceGitTarget(workspace);
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
  if (!isKortixWorkspace()) {
    process.stderr.write(
      `${status.err(`Not a Kortix workspace — no .kortix/ or kortix.yaml in ${process.cwd()}.`)}\n` +
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

  // ── Auth (host: --host → sandbox env token → link.json → active) ──────────
  const hostFromLink = !flags.host && !hasEnvTokenHost() ? loadWorkspaceLink()?.host : undefined;
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

  // ── Verify the manifest "compiles" before we touch the cloud ──────────────
  // Parse + validate kortix.yaml locally so a broken config fails fast — long
  // before we create a workspace, commit, or push. Also yields the env: spec
  // we use to make sure required secrets are set.
  const prepared = prepareManifest(flags);
  if (!prepared.ok) return 1;

  // ── Resolve state: already linked (sync) vs first ship (create) ───────────
  const linkedId = resolveWorkspaceId(flags.workspace);
  try {
    if (linkedId) {
      return await shipExisting(client, auth, linkedId, flags, prepared.env);
    }
    return await shipFirstTime(client, auth, hostName, flags, prepared.env);
  } catch (err) {
    return surface(err);
  }
}

/**
 * Parse + statically validate the local kortix.yaml (the "compile" check).
 * Returns `ok:false` to abort the ship, plus the parsed `env:` spec so the
 * caller can reconcile required secrets. A YAML syntax error or a schema
 * error blocks the ship unless `--no-verify` is passed; warnings never block.
 */
function prepareManifest(flags: ShipFlags): { ok: boolean; env: EnvSpec } {
  const empty: EnvSpec = { required: [], optional: [] };

  let manifest: LocalManifest | null;
  try {
    manifest = loadLocalManifest();
  } catch (err) {
    const detail = (err as Error).message;
    if (flags.noVerify) {
      process.stdout.write(
        `  ${status.warn(`kortix.yaml has a syntax error (ignored via --no-verify)`)}\n`,
      );
      return { ok: true, env: empty };
    }
    process.stderr.write(
      `\n${status.err("kortix.yaml doesn't parse — fix it before shipping.")}\n` +
        `  ${C.dim}${detail.split('\n').join('\n  ')}${C.reset}\n` +
        `  ${C.dim}Bypass with ${C.reset}${C.cyan}--no-verify${C.reset}${C.dim}.${C.reset}\n\n`,
    );
    return { ok: false, env: empty };
  }

  // No kortix.yaml at all (a `.kortix/`-only workspace) — nothing to verify.
  if (!manifest) return { ok: true, env: empty };

  if (!flags.noVerify) {
    const { errors, warnings } = lintManifest(manifest.data, manifest.format);
    for (const w of warnings) process.stdout.write(`  ${status.warn(w)}\n`);
    if (errors.length > 0) {
      process.stderr.write(
        `\n${status.err(
          `kortix.yaml has ${errors.length} error${errors.length === 1 ? '' : 's'}:`,
        )}\n`,
      );
      for (const e of errors) process.stderr.write(`  ${C.dim}•${C.reset} ${e}\n`);
      process.stderr.write(
        `  ${C.dim}Fix them, or bypass with ${C.reset}${C.cyan}--no-verify${C.reset}${C.dim}.${C.reset}\n\n`,
      );
      return { ok: false, env: manifest.env };
    }
    process.stdout.write(`  ${status.ok('kortix.yaml verified')}\n`);
  }

  return { ok: true, env: manifest.env };
}

/**
 * Make sure the env vars the manifest declares (`[env]` required + optional)
 * are set on the cloud workspace. Missing ones are prompted for (masked) and
 * uploaded in place — so a single `kortix ship` leaves the workspace ready to
 * run. Required and optional are both offered (blank skips); skipping a
 * required one warns but never hard-fails (required is advisory at boot).
 * Non-interactive / --yes / --no-env: skip prompts, warn only about missing
 * required vars.
 */
async function ensureWorkspaceEnv(
  client: ApiClient,
  workspaceId: string,
  spec: EnvSpec,
  flags: ShipFlags,
): Promise<void> {
  if (flags.noEnv || (spec.required.length === 0 && spec.optional.length === 0)) return;

  // Which declared secrets already exist on the cloud workspace?
  let setNames = new Set<string>();
  try {
    const resp = await client.get<WorkspaceSecretsResponse>(`/workspaces/${workspaceId}/secrets`);
    setNames = new Set(resp.items.map((s) => s.name));
  } catch {
    // Couldn't read cloud secrets — don't block the ship over env setup.
    return;
  }

  // Required first, then optional — each tagged so the user knows what matters.
  const missing: { name: string; required: boolean }[] = [
    ...spec.required.filter((n) => !setNames.has(n)).map((name) => ({ name, required: true })),
    ...spec.optional.filter((n) => !setNames.has(n)).map((name) => ({ name, required: false })),
  ];
  const requiredMissing = missing.filter((m) => m.required).map((m) => m.name);

  if (missing.length === 0) {
    const total = spec.required.length + spec.optional.length;
    process.stdout.write(`  ${C.dim}env  ${total} declared secret${total === 1 ? '' : 's'} set${C.reset}\n`);
    return;
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  // Non-interactive or --yes: can't prompt safely. Only nag about required.
  if (!interactive || flags.yes) {
    if (requiredMissing.length > 0) {
      const plural = requiredMissing.length === 1 ? '' : 's';
      process.stdout.write(
        `  ${status.warn(`${requiredMissing.length} required secret${plural} not set: ${requiredMissing.join(', ')}`)}\n` +
          `  ${C.dim}Set ${requiredMissing.length === 1 ? 'it' : 'them'} with ${C.reset}${C.cyan}kortix secrets set ${requiredMissing[0]}=…${C.reset}${C.dim} or re-run ship interactively.${C.reset}\n`,
      );
    }
    return;
  }

  process.stdout.write(
    `\n  ${C.bold}env${C.reset}  ${C.dim}${missing.length} declared secret${missing.length === 1 ? '' : 's'} not set — enter ${missing.length === 1 ? 'it' : 'them'} now (blank = skip):${C.reset}\n`,
  );
  let setCount = 0;
  const stillMissing: string[] = [];
  for (const { name, required } of missing) {
    const tag = required ? `${C.yellow}required${C.reset}` : `${C.faded}optional${C.reset}`;
    const value = await promptSecret(`    ${name} ${C.dim}(${tag}${C.dim})${C.reset}`);
    if (!value) {
      if (required) stillMissing.push(name);
      continue;
    }
    try {
      await client.post(`/workspaces/${workspaceId}/secrets`, { name, value });
      setCount += 1;
      process.stdout.write(`    ${status.ok(`${C.bold}${name}${C.reset} set`)}\n`);
    } catch (err) {
      if (required) stillMissing.push(name);
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      process.stderr.write(`    ${status.err(`couldn't set ${name}: ${msg}`)}\n`);
    }
  }
  if (setCount > 0) {
    process.stdout.write(
      `  ${C.dim}${setCount} secret${setCount === 1 ? '' : 's'} saved to the cloud workspace.${C.reset}\n`,
    );
  }
  if (stillMissing.length > 0) {
    process.stdout.write(
      `  ${status.warn(`required still unset: ${stillMissing.join(', ')}`)} ${C.dim}— sessions start but may misbehave.${C.reset}\n`,
    );
  }
}

// ── Connectors: guided connect on ship ──────────────────────────────────────

/**
 * Say so when the connector routes are simply not there.
 *
 * Both connector steps below swallow their errors, and correctly so: a transient
 * reconcile failure does not invalidate a completed git push, and the server's
 * rotating discovery sweep retries the project anyway. But `404` is not
 * transient — it means this binary is calling a route the API no longer has, and
 * no amount of retrying fixes it. That is exactly the failure that went
 * unnoticed for weeks after `/executor/*` became `/connectors/*`: every sandbox
 * CLI 404ed on every connector call and printed nothing at all.
 *
 * So: surface a 404 and name the fix, keep swallowing everything else. Written
 * to STDERR so it cannot be mistaken for ship output a script is parsing.
 */
function warnIfConnectorRouteMissing(err: unknown): void {
  if (!(err instanceof ApiError) || err.status !== 404) return;
  process.stderr.write(
    `${status.warn('connector routes returned 404 — this `kortix` CLI looks out of date')}\n` +
      `  ${C.dim}Update it with ${C.reset}${C.cyan}kortix update${C.reset}${C.dim}, then re-run ship. ` +
      `Connectors were NOT reconciled.${C.reset}\n`,
  );
}


interface ShipConnector {
  slug: string;
  name: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'postman' | 'graphql' | 'http';
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
  authSecret: string | null;
  secretSet: boolean;
}

/**
 * After a successful push, reconcile the connector catalog from the just-shipped
 * manifest and walk the user through connecting anything that still needs auth —
 * Pipedream apps via an auto-finalizing one-click connection URL, and
 * HTTP/OpenAPI/GraphQL/MCP connectors via their credential secret. Mirrors
 * `ensureWorkspaceEnv` so a single `kortix ship` leaves the workspace ready to run.
 * Skipped with --no-connect; non-interactive / --yes only nags with the slugs
 * left to connect. Never hard-fails the ship.
 */
async function ensureConnectorsConnected(
  client: ApiClient,
  workspaceId: string,
  flags: ShipFlags,
): Promise<void> {
  if (flags.noConnect) return;
  const ex = `/connectors/workspaces/${workspaceId}`;

  let connectors: ShipConnector[];
  try {
    const resp = await client.get<{ connectors: ShipConnector[] }>(`${ex}/connectors`);
    connectors = resp.connectors;
  } catch (err) {
    warnIfConnectorRouteMissing(err);
    return; // don't block the ship over connector setup
  }
  if (connectors.length === 0) return;

  const pending = connectors.filter(
    (c) => c.status === 'needs_auth' || (!!c.authSecret && !c.secretSet),
  );
  if (pending.length === 0) {
    process.stdout.write(
      `  ${C.dim}connectors  ${connectors.length} declared, all connected${C.reset}\n`,
    );
    return;
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive || flags.yes) {
    const slugs = pending.map((c) => c.slug).join(', ');
    process.stdout.write(
      `  ${status.warn(`${pending.length} connector${pending.length === 1 ? '' : 's'} not connected: ${slugs}`)}\n` +
        `  ${C.dim}Connect ${pending.length === 1 ? 'it' : 'them'} with ${C.reset}${C.cyan}kortix connectors connect <slug>${C.reset}${C.dim} (or re-run ship interactively).${C.reset}\n`,
    );
    return;
  }

  process.stdout.write(
    `\n  ${C.bold}connectors${C.reset}  ${C.dim}${pending.length} need setup — connect ${pending.length === 1 ? 'it' : 'them'} now (blank = skip):${C.reset}\n`,
  );
  let connected = 0;
  let connectionLinks = 0;
  for (const c of pending) {
    if (c.provider === 'pipedream') {
      if (await connectPipedreamApp(client, workspaceId, c)) connectionLinks += 1;
    } else if (c.authSecret) {
      if (await setConnectorCredential(client, ex, c)) connected += 1;
    } else {
      process.stdout.write(`    ${C.dim}${c.slug}: no auth flow to run — skipped${C.reset}\n`);
    }
  }
  if (connected > 0) {
    process.stdout.write(
      `  ${C.dim}${connected} connector${connected === 1 ? '' : 's'} connected.${C.reset}\n`,
    );
  }
  if (connectionLinks > 0) {
    process.stdout.write(
      `  ${C.dim}${connectionLinks} auto-finalizing connection URL${connectionLinks === 1 ? '' : 's'} created.${C.reset}\n`,
    );
  }
}

/**
 * Reconcile the pushed manifest into the server runtime catalog.
 *
 * This step always runs. The --no-connect flag only skips credential prompts.
 */
export async function reconcileShippedManifest(
  client: ApiClient,
  workspaceId: string,
): Promise<void> {
  try {
    await client.post(`/connectors/workspaces/${workspaceId}/connectors/sync`);
  } catch (err) {
    // A reconcile failure does not invalidate the completed git push.
    // The rotating server discovery sweep retries the workspace, except on a
    // 404, which no retry can fix. See warnIfConnectorRouteMissing.
    warnIfConnectorRouteMissing(err);
  }
}

/** Mint one auto-finalizing Pipedream connection URL for the user. */
async function connectPipedreamApp(
  client: ApiClient,
  workspaceId: string,
  c: ShipConnector,
): Promise<boolean> {
  try {
    const resp = await client.post<{ url: string; expires_at: string }>(
      `/workspaces/${workspaceId}/connect-requests`,
      { slug: c.slug },
    );
    process.stdout.write(`\n    ${C.bold}${c.slug}${C.reset} ${C.faded}(${c.name})${C.reset}\n`);
    process.stdout.write(
      `    ${C.dim}Authorize:${C.reset} ${C.cyan}${resp.url}${C.reset}\n` +
        `    ${C.dim}Expires ${resp.expires_at}. The connection finalizes automatically.${C.reset}\n`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error).message;
    process.stderr.write(`    ${status.err(`connect ${c.slug} failed: ${msg}`)}\n`);
    return false;
  }
}

/** HTTP/OpenAPI/GraphQL/MCP: store the bearer/basic credential secret value. */
async function setConnectorCredential(
  client: ApiClient,
  ex: string,
  c: ShipConnector,
): Promise<boolean> {
  const value = await promptSecret(`    ${c.slug} ${C.dim}(credential → ${c.authSecret})${C.reset}`);
  if (!value) {
    process.stdout.write(`    ${C.dim}skipped ${c.slug}${C.reset}\n`);
    return false;
  }
  try {
    await client.put(`${ex}/connectors/${encodeURIComponent(c.slug)}/credential`, { value });
    process.stdout.write(`    ${status.ok(`${C.bold}${c.slug}${C.reset} credential set`)}\n`);
    return true;
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error).message;
    process.stderr.write(`    ${status.err(`couldn't set ${c.slug}: ${msg}`)}\n`);
    return false;
  }
}

function isGitHubUrl(url: string): boolean {
  return /(^https?:\/\/github\.com\/)|(^git@github\.com:)/i.test(url);
}

interface LinkRepoResponse {
  workspace: WorkspaceSummary;
}

/**
 * Link an existing GitHub repo to a new cloud workspace — the same import the
 * web UI does, from your terminal. Default path is the one-click GitHub App
 * install (no secret to manage): if the app isn't installed yet, we print the
 * install link, you authorize, and we retry. `--github-token <PAT>` skips the
 * app entirely (the App-free fallback — handy where the app can't be installed,
 * e.g. local dev whose callback points at prod).
 */
export async function linkGitHubBackedWorkspace(
  client: ApiClient,
  opts: { repoUrl: string; name: string; accountId: string; githubToken?: string; yes: boolean },
): Promise<WorkspaceSummary> {
  const body = (token?: string) => ({
    repo_url: opts.repoUrl,
    name: opts.name,
    account_id: opts.accountId,
    ...(token ? { github_token: token } : {}),
  });

  // PAT path: one shot, no app needed.
  if (opts.githubToken) {
    const res = await client.post<LinkRepoResponse>(
      '/workspaces/link-repository',
      body(opts.githubToken),
    );
    return res.workspace;
  }

  // App path: retry around the one-click install.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await client.post<LinkRepoResponse>('/workspaces/link-repository', body());
      return res.workspace;
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
        throw new Error('GitHub App install required — re-run without -y after installing, or pass --github-token <PAT>.');
      }
      const again = await confirm('Installed it? Retry the link', true);
      if (!again) throw new Error('Aborted — install the Kortix GitHub App (or use --github-token) then run `kortix ship` again.');
    }
  }
  throw new Error('GitHub App still not detected after several tries — install it, or use --github-token <PAT>.');
}

// ── First ship: create the cloud workspace, wire the remote, push ─────────────
async function shipFirstTime(
  client: ApiClient,
  auth: Auth,
  hostName: string | undefined,
  flags: ShipFlags,
  env: EnvSpec,
): Promise<number> {
  const name = flags.name ?? manifestWorkspaceName() ?? basename(process.cwd());

  // Which account owns the new workspace? Ask when there's a real choice.
  const accountId = await resolveShipAccount(client, auth, flags);

  // Decide origin without asking: explicit flag → existing remote → managed.
  const explicitUrl =
    flags.origin && flags.origin !== 'managed' && flags.origin !== 'github'
      ? flags.origin
      : null;
  const forceManaged = flags.origin === 'managed';
  const existingOrigin = forceManaged ? null : detectOrigin();
  const byoUrl = explicitUrl ?? existingOrigin;

  let workspace: WorkspaceSummary;
  let gitTarget: WorkspaceGitTarget;
  let pushToken: string | null = null;
  let pushUsername = 'x-access-token';

  if (byoUrl) {
    const github = isGitHubUrl(byoUrl);
    process.stdout.write(
      `\n  ${C.bold}kortix ship${C.reset}  ${C.dim}new workspace → your git${C.reset}\n` +
        `  ${C.dim}origin  ${C.reset}${byoUrl}${github ? `  ${C.faded}(GitHub)${C.reset}` : ''}\n\n`,
    );
    if (flags.dryRun) {
      const how = github
        ? `link ${byoUrl} via GitHub App${flags.githubToken ? ' token' : ' (1-click install if needed)'}`
        : `POST /workspaces {repo_url:"${byoUrl}"}`;
      process.stdout.write(`  ${C.dim}[dry-run] would: ${how} + push${C.reset}\n\n`);
      return 0;
    }
    // GitHub origin → the seamless import (one-click App install, or --github-token).
    // Non-GitHub remote → the generic workspace link.
    workspace = github
      ? await linkGitHubBackedWorkspace(client, { repoUrl: byoUrl, name, accountId, githubToken: flags.githubToken, yes: flags.yes })
      : await client.post<WorkspaceSummary>('/workspaces', { repo_url: byoUrl, name, account_id: accountId });
    bindShippedFolder(workspace, hostName, auth);
    // BYO stays BYO: push with the user's own git credentials, to their remote.
    gitTarget = { repoUrl: workspace.repo_url, credentialMode: 'none' };
    // Only touch the remote when the user named one explicitly — an existing
    // `origin` is left exactly as-is so their credential setup keeps working.
    if (explicitUrl) setOrigin(explicitUrl);
  } else {
    process.stdout.write(
      `\n  ${C.bold}kortix ship${C.reset}  ${C.dim}new workspace → managed Kortix git${C.reset}\n` +
        `  ${C.dim}name    ${C.reset}${name}\n\n`,
    );
    if (flags.dryRun) {
      process.stdout.write(
        `  ${C.dim}[dry-run] would: POST /workspaces/provision {name:"${name}"}, set origin, push${C.reset}\n\n`,
      );
      return 0;
    }
    const prov = await client.post<ProvisionResponse>('/workspaces/provision', {
      name,
      account_id: accountId,
    });
    workspace = prov;
    // Bind the folder to the workspace the INSTANT it exists — before resolving a
    // push credential, committing, or pushing, any of which can fail. Without
    // this, a failure after provision left an unlinked cloud workspace behind and
    // the retry provisioned a SECOND one, silently burning the account's
    // workspace quota until creation started 403ing on the limit.
    bindShippedFolder(workspace, hostName, auth);
    gitTarget = resolveProvisionShipGitTarget(prov);
    if (gitTarget.credentialMode === 'kortix-token') {
      // Proxy origin — we push with our own Kortix token; the API resolves the
      // upstream + host credential server-side. No provider token is exported.
      pushToken = auth.token;
    } else {
      pushToken = prov.push_token;
      pushUsername = prov.git_username ?? pushUsername;
      // Proxy-less host: fall back to a repo-scoped provider token. Older
      // provision responses may omit it even though /git-token can mint one.
      // Never fall back to a server-global PAT (the server refuses to export it).
      if (!pushToken) {
        const tok = await client.post<GitTokenResponse>(
          `/workspaces/${workspace.workspace_id}/git-token`,
        );
        pushToken = tok.push_token;
        pushUsername = tok.git_username ?? pushUsername;
      }
    }
    setOrigin(gitTarget.repoUrl);
    if (gitTarget.credentialMode === 'kortix-token') {
      configureWorkspaceGitAuth(process.cwd(), gitTarget.repoUrl);
    }
  }

  const committed = commitIfNeeded(flags);
  if (committed === 'error') return 1;

  await ensureWorkspaceEnv(client, workspace.workspace_id, env, flags);

  const pushed = await pushWorkspaceBranch(client, workspace, gitTarget, pushToken, pushUsername);
  if (!pushed) return 1;

  await reconcileShippedManifest(client, workspace.workspace_id);
  await ensureConnectorsConnected(client, workspace.workspace_id, flags);

  reportShipped(auth, workspace, gitTarget.repoUrl);
  return 0;
}

// ── Subsequent ship: commit + push to the linked workspace ────────────────────
async function shipExisting(
  client: ApiClient,
  auth: Auth,
  workspaceId: string,
  flags: ShipFlags,
  env: EnvSpec,
): Promise<number> {
  let workspace: WorkspaceSummary;
  try {
    workspace = await client.get<WorkspaceSummary>(`/workspaces/${workspaceId}`);
  } catch (err) {
    const handled = explainLinkedWorkspaceError(err, workspaceId, auth);
    if (handled !== null) return handled;
    throw err;
  }
  const target = resolveExistingShipGitTarget(workspace);
  const mintsProviderToken = target.credentialMode === 'managed-git-token';
  const kortixOwnsOrigin = target.credentialMode !== 'none';
  const repoUrl = target.repoUrl;

  process.stdout.write(
    `\n  ${C.bold}kortix ship${C.reset}  ${C.dim}sync${C.reset}\n` +
      `  ${C.dim}workspace ${C.reset}${workspace.name} ${C.faded}(${workspace.workspace_id})${C.reset}\n` +
      `  ${C.dim}branch  ${C.reset}${currentBranch()}\n\n`,
  );

  if (flags.dryRun) {
    process.stdout.write(
      `  ${C.dim}[dry-run] would: ${mintsProviderToken ? 'mint push token, ' : ''}commit + push to ${repoUrl}${C.reset}\n\n`,
    );
    return 0;
  }

  // Push credential: through the proxy we authenticate with our own Kortix
  // token; a proxy-less host mints a fresh repo-scoped provider token per ship
  // (never persisted in .git/config).
  let pushToken: string | null = null;
  let pushUsername = 'x-access-token';
  if (target.credentialMode === 'kortix-token') {
    pushToken = auth.token;
  } else if (mintsProviderToken) {
    const tok = await client.post<GitTokenResponse>(`/workspaces/${workspaceId}/git-token`);
    pushToken = tok.push_token;
    pushUsername = tok.git_username ?? pushUsername;
  }
  // Kortix owns the remote URL for proxy + managed workspaces, so keep origin
  // aligned with the target the credential above matches. BYO repos may have
  // lost their remote (fresh clone of a linked repo); heal only when missing so
  // user-managed credentials stay untouched.
  if (kortixOwnsOrigin) setOrigin(repoUrl);
  else ensureOrigin(repoUrl);
  // Leave the repo able to `git push` on its own afterwards, same as a
  // `kortix workspaces clone` — the helper hands git a Kortix token on demand
  // without ever writing one into .git/config.
  if (target.credentialMode === 'kortix-token') configureWorkspaceGitAuth(process.cwd(), repoUrl);

  const committed = commitIfNeeded(flags);
  if (committed === 'error') return 1;

  await ensureWorkspaceEnv(client, workspaceId, env, flags);

  const pushed = await pushWorkspaceBranch(client, workspace, target, pushToken, pushUsername);
  if (!pushed) return 1;

  await reconcileShippedManifest(client, workspaceId);
  await ensureConnectorsConnected(client, workspaceId, flags);

  reportShipped(auth, workspace, repoUrl);
  return 0;
}

/** Write `.kortix/link.json` so this folder is bound to the cloud workspace.
 *  Called the moment the workspace exists — see the note at its first-ship call
 *  site for why ordering matters. */
function bindShippedFolder(
  workspace: WorkspaceSummary,
  hostName: string | undefined,
  auth: Auth,
): void {
  saveWorkspaceLink({
    workspace_id: workspace.workspace_id,
    account_id: workspace.account_id,
    host: hostName ?? activeHostName() ?? 'default',
    host_url: auth.api_base,
    linked_at: new Date().toISOString(),
  });
}

// ── git helpers ─────────────────────────────────────────────────────────────

/** The display name from kortix.yaml's workspace.name, if present. Lets a
 *  first ship honor the manifest instead of defaulting to the folder name. */
function manifestWorkspaceName(): string | undefined {
  try {
    const m = loadLocalManifest();
    const workspace = m?.data?.workspace as { name?: unknown } | undefined;
    const name = typeof workspace?.name === 'string' ? workspace.name.trim() : '';
    return name || undefined;
  } catch {
    return undefined;
  }
}

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
 * per-workspace `gitops.push` capability) would still serve it. So when a proxy
 * push fails on a managed repo, retry once against the raw upstream with a
 * minted repo-scoped token before giving up: either transport being unavailable
 * is survivable, only both failing is a real error. Returns the branch, or null.
 */
async function pushWorkspaceBranch(
  client: ApiClient,
  workspace: WorkspaceSummary,
  target: WorkspaceGitTarget,
  pushToken: string | null,
  pushUsername: string,
): Promise<string | null> {
  const canRetry = target.credentialMode === 'kortix-token' && workspaceIsManaged(workspace);
  const pushed = pushCurrentBranch(target.repoUrl, pushToken, pushUsername, {
    quietOnFailure: canRetry,
  });
  if (pushed || !canRetry) return pushed;

  let minted: GitTokenResponse;
  try {
    minted = await client.post<GitTokenResponse>(`/workspaces/${workspace.workspace_id}/git-token`);
  } catch {
    // No second transport available — report the push failure we swallowed.
    process.stderr.write(`\n${status.err('git push failed.')}\n`);
    return null;
  }
  process.stdout.write(
    `  ${status.warn('Proxy push rejected — retrying against the managed upstream.')}\n`,
  );
  const upstreamUrl = minted.repo_url || workspace.repo_url;
  setOrigin(upstreamUrl);
  return pushCurrentBranch(upstreamUrl, minted.push_token, minted.git_username || pushUsername);
}

/** `-c http.<scheme>://<host>/.extraheader=AUTHORIZATION: basic <b64>` —
 *  mirrors the backend's git auth scheme (workspaces/git.ts). The extraheader
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

function reportShipped(auth: Auth, workspace: WorkspaceSummary, repoUrl: string): void {
  // Prefer the server-provided dashboard URL; only fall back to guessing from
  // the API host for older backends that don't return one.
  const url = workspaceWebUrl(auth.api_base, workspace.workspace_id, workspace.dashboard_url);
  process.stdout.write(
    `\n${status.ok(`Shipped ${C.bold}${workspace.name}${C.reset}`)}\n` +
      `  ${C.dim}repo  ${C.reset}${repoUrl}\n` +
      `  ${C.dim}live  ${C.reset}${C.cyan}${url}${C.reset}\n\n`,
  );
}

/**
 * Resolve which account a new workspace should belong to:
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
      label: a.name,
      sublabel: `${a.slug} · ${a.role}`,
    })),
  });
  if (!picked) throw new Error('No account selected.');
  return picked.account_id;
}

// ── plumbing ────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): ShipFlags {
  const rest = [...argv];
  const flags: ShipFlags = {
    noCommit: false,
    noVerify: false,
    noEnv: false,
    noConnect: false,
    yes: false,
    dryRun: false,
    help: false,
  };
  flags.name = takeFlagValue(rest, ['--name']);
  flags.account = takeFlagValue(rest, ['--account']);
  flags.origin = takeFlagValue(rest, ['--origin']);
  flags.githubToken = takeFlagValue(rest, ['--github-token']);
  flags.message = takeFlagValue(rest, ['--message', '-m']);
  flags.workspace = takeFlagValue(rest, ['--workspace', '--project']);
  flags.host = takeFlagValue(rest, ['--host']);
  flags.noCommit = takeFlagBool(rest, ['--no-commit']);
  flags.noVerify = takeFlagBool(rest, ['--no-verify']);
  flags.noEnv = takeFlagBool(rest, ['--no-env']);
  flags.noConnect = takeFlagBool(rest, ['--no-connect']);
  flags.yes = takeFlagBool(rest, ['-y', '--yes']);
  flags.dryRun = takeFlagBool(rest, ['-n', '--dry-run']);
  flags.help = takeFlagBool(rest, ['-h', '--help']);
  if (rest.length > 0) throw new Error(`kortix ship: unknown option "${rest[0]}"`);
  return flags;
}

/**
 * When the linked workspace can't be fetched, explain *why* in terms of the
 * link — the common case is "you shipped under account A, then logged in as
 * account B that can't see it." Returns an exit code if it handled the error,
 * or null to let the generic handler take over.
 */
function explainLinkedWorkspaceError(err: unknown, workspaceId: string, auth: Auth): number | null {
  if (!(err instanceof ApiError)) return null;
  const link = loadWorkspaceLink();
  const host = link?.host ?? 'default';

  if (err.status === 403) {
    const linkedAccount = link?.account_id ? ` ${C.faded}(account ${link.account_id.slice(0, 8)})${C.reset}` : '';
    process.stderr.write(
      `\n${status.err("This folder is linked to a workspace on an account you can't access.")}\n` +
        `  ${C.dim}linked workspace ${C.reset}${workspaceId}${linkedAccount}\n` +
        `  ${C.dim}logged in as   ${C.reset}account ${auth.account_id.slice(0, 8)} ${C.faded}(host "${host}")${C.reset} — no access to that account\n\n` +
        `  ${C.dim}The link lives in ${C.reset}.kortix/link.json${C.dim}. Fix it one way:${C.reset}\n` +
        `    ${C.dim}• Log in with the account that has access:${C.reset}  ${C.cyan}kortix logout && kortix login${C.reset}\n` +
        `    ${C.dim}• Or get invited / granted access to that workspace, then retry.${C.reset}\n` +
        `    ${C.dim}• Or register this folder as a new workspace:${C.reset}  ${C.cyan}kortix workspaces unlink${C.reset}${C.dim} then ${C.reset}${C.cyan}kortix ship${C.reset}\n\n`,
    );
    return 1;
  }

  if (err.status === 404) {
    process.stderr.write(
      `\n${status.err('The linked workspace no longer exists (or was archived).')}\n` +
        `  ${C.dim}linked workspace ${C.reset}${workspaceId} ${C.faded}(host "${host}")${C.reset}\n\n` +
        `  ${C.dim}Re-point this folder:${C.reset}\n` +
        `    ${C.dim}• New workspace under your account:${C.reset}  ${C.cyan}kortix workspaces unlink${C.reset}${C.dim} then ${C.reset}${C.cyan}kortix ship${C.reset}\n` +
        `    ${C.dim}• Existing workspace:${C.reset}  ${C.cyan}kortix workspaces link <id>${C.reset}\n\n`,
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
      // Don't diagnose — the server owns the reason. The one thing we DO know
      // is that a stale CLI is a common cause (older builds pushed to the raw
      // upstream with a minted provider token instead of the Kortix git proxy,
      // which a token-configured host can't hand out), so say that and stop.
      process.stderr.write(
        `${status.err(err.message)}\n` +
          `  ${C.dim}Update first — ${C.reset}${C.cyan}kortix update${C.reset}${C.dim} — then retry. Still failing? ` +
          `Pass ${C.reset}${C.cyan}--origin <git-url>${C.reset}${C.dim} to push to your own remote instead.${C.reset}\n`,
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
