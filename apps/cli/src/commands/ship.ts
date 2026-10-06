import { basename } from 'node:path';

import { type Auth, loadAuth, loadAuthForHost } from '../api/auth.ts';
import { type ApiClient, ApiError, clientFromAuth } from '../api/client.ts';
import { activeHostName, hasEnvTokenHost } from '../api/config.ts';
import type { ProjectSecretsResponse, ProjectSummary } from '../api/types.ts';
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue, tokenRejectedLine } from '../command-helpers.ts';
import {
  commitIfNeeded,
  currentBranch,
  detectOrigin,
  ensureOrigin,
  explainLinkedProjectError,
  isGitHubUrl,
  linkGitHubBackedProject,
  manifestProjectName,
  pushProjectBranch,
  resolvePushCredential,
  resolveShipAccount,
  run,
  setOrigin,
} from '../git-ops.ts';
import { type EnvSpec, type LocalManifest, lintManifest, loadLocalManifest } from '../manifest.ts';
import {
  type ProjectGitTarget,
  configureProjectGitAuth,
  resolveProjectGitTarget,
} from '../project-git.ts';
import { isKortixProject, loadLink, resolveProjectId, saveLink } from '../project-link.ts';
import { lintProject } from '../project-lint.ts';
import { promptSecret } from '../prompts.ts';
import { C, help, status } from '../style.ts';
import { projectWebUrl } from '../web-url.ts';
import { ensureConnectorsConnected, reconcileShippedManifest } from './ship-connectors.ts';

const HELP = help`Usage: kortix ship [options]

Stage everything, commit, and push your current branch to the project's git
repo — in one command. Run it once to create the project, then run it again
any time to sync. It's the everyday "save my work to the cloud" command.

Every run:
  1. run the kortix validate checks          (skip with --no-verify)
  2. git add -A + commit                      (skipped if nothing changed)
  3. offer to set any [env] secret not yet set (prompts you; skip with --no-env)
  4. push the branch you're on → the same-named branch on the project's repo
  5. connect any declared connector that still needs auth   (skip with --no-connect)

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

Where it backs the project (origin is inferred, never asked):
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
  create the project under (skip with --account or -y). No snapshot builds.

Options:
  --name <project>     Display name for a new project (default: folder name).
  --account <id|slug>  Account to create the project under (first ship only).
  --origin <value>     Override origin choice:
                         managed      force a managed Kortix repo
                         <git-url>    register + push to this remote
  --github-token <pat> Link a GitHub origin with this token instead of the
                       GitHub App (App-free import; needs repo Contents R/W).
  -m, --message <msg>  Commit message for the sync (default: "kortix: ship").
  --no-commit          Don't commit. Fail if the working tree is dirty.
  --no-verify          Skip the kortix validate checks.
  --no-env             Skip the [env] secret check + prompts.
  --no-connect         Skip the connector connect/credential prompts.
  -y, --yes            Don't prompt; use the active account, skip secret prompts.
  -n, --dry-run        Print what would happen, do nothing.
  --project <id>       Operate on this project id (default: linked).
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
  project?: string;
  host?: string;
}

interface ProvisionResponse extends ProjectSummary {
  push_token: string | null;
  git_username?: string | null;
  repo_id: string;
}

export async function runShip(argv: string[]): Promise<number> {
  const flags = takeFlags(
    argv,
    HELP,
    (rest): ShipFlags => ({
      name: takeFlagValue(rest, ['--name']),
      account: takeFlagValue(rest, ['--account']),
      origin: takeFlagValue(rest, ['--origin']),
      githubToken: takeFlagValue(rest, ['--github-token']),
      message: takeFlagValue(rest, ['--message', '-m']),
      project: takeFlagValue(rest, ['--project']),
      host: takeFlagValue(rest, ['--host']),
      noCommit: takeFlagBool(rest, ['--no-commit']),
      noVerify: takeFlagBool(rest, ['--no-verify']),
      noEnv: takeFlagBool(rest, ['--no-env']),
      noConnect: takeFlagBool(rest, ['--no-connect']),
      yes: takeFlagBool(rest, ['-y', '--yes']),
      dryRun: takeFlagBool(rest, ['-n', '--dry-run']),
    }),
  );
  if (typeof flags === 'number') return flags;

  // ── Guards ───────────────────────────────────────────────────────────────
  if (!isKortixProject()) {
    process.stderr.write(
      `${status.err(`Not a Kortix project — no .kortix/ or kortix.yaml in ${process.cwd()}.`)}\n` +
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
  const hostFromLink = !flags.host && !hasEnvTokenHost() ? loadLink()?.host : undefined;
  const hostName = flags.host ?? hostFromLink;
  const auth = hostName ? loadAuthForHost(hostName) : loadAuth();
  if (!auth?.token) {
    if (hostName) {
      process.stderr.write(
        `${status.err(`Host "${hostName}" is not logged in.`)} Run ` +
          `${C.cyan}kortix login --host ${hostName}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(
        `${status.err('Not logged in.')} Run ${C.cyan}kortix login${C.reset}.\n`,
      );
    }
    return 1;
  }
  const client = clientFromAuth(auth);

  // ── Verify the manifest "compiles" before we touch the cloud ──────────────
  // Parse + validate kortix.yaml locally so a broken config fails fast — long
  // before we create a project, commit, or push. Also yields the env: spec
  // we use to make sure required secrets are set.
  const prepared = prepareManifest(flags);
  if (!prepared.ok) return 1;

  // ── Resolve state: already linked (sync) vs first ship (create) ───────────
  const linkedId = resolveProjectId(flags.project);
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
 * Parse the local kortix.yaml and run the `kortix validate` checks on it.
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

  // NO MANIFEST AT ALL. This used to pass as "a `.kortix/`-only project —
  // nothing to verify", and it is the client half of the same defect as the
  // server's opt-in seeding: it let `kortix ship` push a project that has no
  // kortix.yaml, so the project came out with no declared agents, no skills,
  // and manifest detection falling back to v1 `kortix.toml`.
  //
  // A project always has a manifest (apps/api/src/projects/managed-repo-seed.ts).
  // Ship declares `seed_starter: false` — it takes responsibility for the first
  // commit — so it must actually HAVE one to push. `--no-verify` deliberately
  // does not bypass this: it waives *validation* of a manifest, not its
  // existence, and waiving existence is what produced the broken projects.
  if (!manifest) {
    process.stderr.write(
      `\n${status.err('No kortix.yaml here — refusing to ship a project with no manifest.')}\n` +
        `  ${C.dim}A Kortix project is defined by its manifest: agents, skills and\n` +
        `  connectors all come from it. Pushing without one creates a project\n` +
        `  that cannot start a session.${C.reset}\n` +
        `  ${C.dim}Create one with ${C.reset}${C.cyan}kortix init${C.reset}${C.dim} in ${process.cwd()}.${C.reset}\n\n`,
    );
    return { ok: false, env: empty };
  }

  if (!flags.noVerify) {
    // The same checks as `kortix validate`: schema, sandbox Dockerfiles,
    // agent wiring, and the repository size warning.
    const { errors, warnings } = lintManifest(
      manifest.data,
      manifest.format,
      lintProject(manifest.data, manifest.path),
    );
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
 * are set on the cloud project. Missing ones are prompted for (masked) and
 * uploaded in place — so a single `kortix ship` leaves the project ready to
 * run. Required and optional are both offered (blank skips); skipping a
 * required one warns but never hard-fails (required is advisory at boot).
 * Non-interactive / --yes / --no-env: skip prompts, warn only about missing
 * required vars.
 */
async function ensureProjectEnv(
  client: ApiClient,
  projectId: string,
  spec: EnvSpec,
  flags: ShipFlags,
): Promise<void> {
  if (flags.noEnv || (spec.required.length === 0 && spec.optional.length === 0)) return;

  // Which declared secrets already exist on the cloud project?
  let setNames = new Set<string>();
  try {
    const resp = await client.get<ProjectSecretsResponse>(`/projects/${projectId}/secrets`);
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
    process.stdout.write(
      `  ${C.dim}env  ${total} declared secret${total === 1 ? '' : 's'} set${C.reset}\n`,
    );
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
      await client.post(`/projects/${projectId}/secrets`, { name, value });
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
      `  ${C.dim}${setCount} secret${setCount === 1 ? '' : 's'} saved to the cloud project.${C.reset}\n`,
    );
  }
  if (stillMissing.length > 0) {
    process.stdout.write(
      `  ${status.warn(`required still unset: ${stillMissing.join(', ')}`)} ${C.dim}— sessions start but may misbehave.${C.reset}\n`,
    );
  }
}

// ── First ship: create the cloud project, wire the remote, push ─────────────
async function shipFirstTime(
  client: ApiClient,
  auth: Auth,
  hostName: string | undefined,
  flags: ShipFlags,
  env: EnvSpec,
): Promise<number> {
  const name = flags.name ?? manifestProjectName() ?? basename(process.cwd());

  // Which account owns the new project? Ask when there's a real choice.
  const accountId = await resolveShipAccount(client, auth, flags);

  // Decide origin without asking: explicit flag → existing remote → managed.
  const explicitUrl =
    flags.origin && flags.origin !== 'managed' && flags.origin !== 'github' ? flags.origin : null;
  const forceManaged = flags.origin === 'managed';
  const existingOrigin = forceManaged ? null : detectOrigin();
  const byoUrl = explicitUrl ?? existingOrigin;

  let project: ProjectSummary;
  let gitTarget: ProjectGitTarget;
  let cred: { pushToken: string | null; pushUsername: string } = {
    pushToken: null,
    pushUsername: 'x-access-token',
  };

  if (byoUrl) {
    const github = isGitHubUrl(byoUrl);
    process.stdout.write(
      `\n  ${C.bold}kortix ship${C.reset}  ${C.dim}new project → your git${C.reset}\n` +
        `  ${C.dim}origin  ${C.reset}${byoUrl}${github ? `  ${C.faded}(GitHub)${C.reset}` : ''}\n\n`,
    );
    if (flags.dryRun) {
      const how = github
        ? `link ${byoUrl} via GitHub App${flags.githubToken ? ' token' : ' (1-click install if needed)'}`
        : `POST /projects {repo_url:"${byoUrl}"}`;
      process.stdout.write(`  ${C.dim}[dry-run] would: ${how} + push${C.reset}\n\n`);
      return 0;
    }
    // GitHub origin → the seamless import (one-click App install, or --github-token).
    // Non-GitHub remote → the generic project link.
    project = github
      ? await linkGitHubBackedProject(client, {
          repoUrl: byoUrl,
          name,
          accountId,
          githubToken: flags.githubToken,
          yes: flags.yes,
        })
      : await client.post<ProjectSummary>('/projects', {
          repo_url: byoUrl,
          name,
          account_id: accountId,
        });
    bindShippedFolder(project, hostName, auth);
    // BYO stays BYO: push with the user's own git credentials, to their remote.
    gitTarget = { repoUrl: project.repo_url, credentialMode: 'none' };
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
      // WE own the first commit: this folder is already a `kortix init` scaffold
      // and we push its history below with a plain (non-force) push, which a
      // server-seeded repo would reject as non-fast-forward. Seeding is the
      // server's DEFAULT now, so this has to be said out loud — an absent flag
      // means "seed it" (apps/api/src/projects/managed-repo-seed.ts). The
      // project still ends up with a kortix.yaml either way; this only picks
      // who writes it.
      seed_starter: false,
    });
    project = prov;
    // Bind the folder to the project the INSTANT it exists — before resolving a
    // push credential, committing, or pushing, any of which can fail. Without
    // this, a failure after provision left an unlinked cloud project behind and
    // the retry provisioned a SECOND one, silently burning the account's
    // project quota until creation started 403ing on the limit.
    bindShippedFolder(project, hostName, auth);
    gitTarget = resolveProjectGitTarget(prov);
    cred = await resolvePushCredential(client, auth, project.project_id, gitTarget, prov);
    setOrigin(gitTarget.repoUrl);
    if (gitTarget.credentialMode === 'kortix-token') {
      configureProjectGitAuth(process.cwd(), gitTarget.repoUrl);
    }
  }

  return finishShip(client, auth, project, project.project_id, gitTarget, cred, env, flags);
}

// ── Subsequent ship: commit + push to the linked project ────────────────────
async function shipExisting(
  client: ApiClient,
  auth: Auth,
  projectId: string,
  flags: ShipFlags,
  env: EnvSpec,
): Promise<number> {
  let project: ProjectSummary;
  try {
    project = await client.get<ProjectSummary>(`/projects/${projectId}`);
  } catch (err) {
    const handled = explainLinkedProjectError(err, projectId, auth);
    if (handled !== null) return handled;
    throw err;
  }
  const target = resolveProjectGitTarget(project);
  const mintsProviderToken = target.credentialMode === 'managed-git-token';
  const kortixOwnsOrigin = target.credentialMode !== 'none';
  const repoUrl = target.repoUrl;

  process.stdout.write(
    `\n  ${C.bold}kortix ship${C.reset}  ${C.dim}sync${C.reset}\n` +
      `  ${C.dim}project ${C.reset}${project.name} ${C.faded}(${project.project_id})${C.reset}\n` +
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
  const cred = await resolvePushCredential(client, auth, projectId, target);
  // Kortix owns the remote URL for proxy + managed projects, so keep origin
  // aligned with the target the credential above matches. BYO repos may have
  // lost their remote (fresh clone of a linked repo); heal only when missing so
  // user-managed credentials stay untouched.
  if (kortixOwnsOrigin) setOrigin(repoUrl);
  else ensureOrigin(repoUrl);
  // Leave the repo able to `git push` on its own afterwards, same as a
  // `kortix projects clone` — the helper hands git a Kortix token on demand
  // without ever writing one into .git/config.
  if (target.credentialMode === 'kortix-token') configureProjectGitAuth(process.cwd(), repoUrl);

  return finishShip(client, auth, project, projectId, target, cred, env, flags);
}

/**
 * The shared ship tail — commit, set declared env secrets, push, reconcile
 * connectors, report. Both ship paths end here so their output stays
 * byte-identical by construction. Returns the exit code.
 */
async function finishShip(
  client: ApiClient,
  auth: Auth,
  project: ProjectSummary,
  projectId: string,
  target: ProjectGitTarget,
  cred: { pushToken: string | null; pushUsername: string },
  env: EnvSpec,
  flags: ShipFlags,
): Promise<number> {
  const committed = commitIfNeeded(flags);
  if (committed === 'error') return 1;

  await ensureProjectEnv(client, projectId, env, flags);

  const pushed = await pushProjectBranch(
    client,
    project,
    target,
    cred.pushToken,
    cred.pushUsername,
  );
  if (!pushed) return 1;

  await reconcileShippedManifest(client, projectId);
  await ensureConnectorsConnected(client, projectId, flags);

  reportShipped(auth, project, target.repoUrl);
  return 0;
}

/** Write `.kortix/link.json` so this folder is bound to the cloud project.
 *  Called the moment the project exists — see the note at its first-ship call
 *  site for why ordering matters. */
function bindShippedFolder(
  project: ProjectSummary,
  hostName: string | undefined,
  auth: Auth,
): void {
  saveLink({
    project_id: project.project_id,
    account_id: project.account_id,
    host: hostName ?? activeHostName() ?? 'default',
    host_url: auth.api_base,
    linked_at: new Date().toISOString(),
  });
}

function reportShipped(auth: Auth, project: ProjectSummary, repoUrl: string): void {
  // Prefer the server-provided dashboard URL; only fall back to guessing from
  // the API host for older backends that don't return one.
  const url = projectWebUrl(auth.api_base, project.project_id, project.dashboard_url);
  process.stdout.write(
    `\n${status.ok(`Shipped ${C.bold}${project.name}${C.reset}`)}\n` +
      `  ${C.dim}repo  ${C.reset}${repoUrl}\n` +
      `  ${C.dim}live  ${C.reset}${C.cyan}${url}${C.reset}\n\n`,
  );
}

// ── plumbing ─────────────────────────────────────────────────────────────────

function surface(err: unknown): number {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(`${status.err(tokenRejectedLine(err.message, 'Run `kortix login`.'))}\n`);
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
