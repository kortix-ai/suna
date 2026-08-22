import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadAuth } from '../api/auth.ts';
import {
  activeAccount,
  activeHostName,
  clearDefaultProject,
  defaultProject,
  setActiveAccount,
  setDefaultProject,
} from '../api/config.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import { confirm } from '../prompts.ts';
import {
  clearLink,
  isKortixProject,
  loadLink,
  resolveProjectId,
  saveLink,
} from '../project-link.ts';
import { selectFromList } from '../tui-select.ts';
import {
  emitJson,
  locateProjectAnywhere,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { projectWebUrl } from '../web-url.ts';
import { openInBrowser } from '../browser.ts';
import { appendGitExcludeEntries } from '../git-exclude.ts';
import { configureProjectGitAuth, resolveProjectGitTarget } from '../project-git.ts';
import type { Auth } from '../api/auth.ts';
import type { AccountMembership, MeResponse, ProjectSummary } from '../api/types.ts';
import { authHeaderArgs } from './ship.ts';

/** Back-compat alias — the helper moved to ../project-git.ts so `ship` can use
 *  it without an import cycle through this command module. */
export {
  configureProjectGitAuth as configureClonedProjectAuth,
  currentGitCredentialHelperCommand,
} from '../project-git.ts';

const HELP = help`Usage: kortix projects <subcommand>

Subcommands:
  ls [--all]           List projects in the active account (--all spans every
                       account, grouped). (--json)
  info [<id>]          Show one project (defaults to the linked/default) (--json)
  use [<id>]           Set the global DEFAULT project (interactive if omitted).
                       Switches the active account to the project's account.
  unset                Clear the global default project.
  link [<id>]          Bind cwd to a remote project (writes .kortix/link.json)
  unlink               Remove .kortix/link.json from cwd
  open [<id>]          Open the dashboard URL for one project
  clone [<id>] [dir]   Clone through the authenticated Kortix git proxy. Falls
                       back to your local Git credentials for direct BYO repos.
  rm [<id>]            Archive a project (defaults to the linked one).
                       --purge also deletes its managed git repo (irreversible).
                       -y / --yes skips the confirmation.
  features [ls]        List every feature flag with its effective state for the
                       project (Settings → Feature flags). (--json)
  features enable <flag>   Turn a flag on for the project.
  features disable <flag>  Turn a flag off for the project.
  features reset <flag>    Clear the project's override (follow the default).
                       features takes --project <id>; defaults to linked/default.

An explicit <id> on info/open/rm resolves on its own: tries the active host
first, then — unless you pass --host — scans every other logged-in host for
it. A directory link (.kortix/link.json) always wins over the default; the
default is what commands use anywhere else on your machine.

Run \`kortix projects <subcommand> --help\` for options.
`;

export async function runProjects(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // None of the subcommands below own dedicated help text or parse
  // -h/--help themselves, so without this a bare `--help` falls through as
  // an ordinary positional arg — e.g. `projects info --help` would try to
  // look up a project literally named "--help", and `projects rm --help`
  // would silently fall back to archiving the DEFAULT project instead of
  // showing usage.
  // `features` owns its own help text and parses -h/--help itself.
  if ((rest.includes('-h') || rest.includes('--help')) && sub !== 'features' && sub !== 'flags') {
    process.stdout.write(HELP);
    return 0;
  }
  switch (sub) {
    case 'ls':
    case 'list': {
      const restCopy = [...rest];
      const all = takeFlagBool(restCopy, ['--all', '-a']);
      const json = takeFlagBool(restCopy, ['--json']);
      return projectsLs(json, all);
    }
    case 'info': {
      const restCopy = [...rest];
      const json = takeFlagBool(restCopy, ['--json']);
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsInfo(restCopy[0], json, hostArg);
    }
    case 'use':
    case 'default':
      return projectsUse(rest.find((a) => !a.startsWith('-')));
    case 'unset':
    case 'clear':
      return projectsUnset();
    case 'link':
      return projectsLink(rest[0]);
    case 'unlink':
      return projectsUnlink();
    case 'open': {
      const restCopy = [...rest];
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsOpen(restCopy[0], hostArg);
    }
    case 'clone': {
      const restCopy = [...rest];
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsClone(restCopy[0], restCopy[1], hostArg);
    }
    case 'rm':
    case 'remove':
      return projectsRm(rest);
    case 'features':
    case 'flags':
      return projectsFeatures(rest);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── Feature flags (Settings → Feature flags) ───────────────────────────────

const FEATURES_HELP = help`Usage: kortix projects features [ls | enable | disable | reset] [<flag>]

Per-project feature flags — the same switches as Settings → Feature flags.
A flag is a stable key (e.g. apps, voice, llm_gateway). State is stored on
the project row, never in kortix.yaml.

Subcommands:
  ls                    List every flag: key, state, origin, stability. (--json)
  enable <flag>         Set the project override to ON.
  disable <flag>        Set the project override to OFF.
  reset <flag>          Remove the override; the flag follows the platform default.

Options:
  --project <id>        Act on this project (default: linked/default project).
  --host <name>         Use this logged-in host.
  --json                Machine-readable output.

Requires project.customize.write. A flag the platform marks unavailable stays
off regardless of the project override.
`;

interface FeatureFlagRow {
  key: string;
  name: string;
  description: string;
  stability: string;
  available: boolean;
  enabled: boolean;
  overridden: boolean;
}

function featureRows(project: Record<string, unknown>): FeatureFlagRow[] {
  const raw = project.experimental_features;
  return Array.isArray(raw) ? (raw as FeatureFlagRow[]) : [];
}

function printFeatureTable(rows: FeatureFlagRow[]): void {
  if (rows.length === 0) {
    process.stdout.write(`${status.info('No feature flags reported by this host.')}\n`);
    return;
  }
  const keyW = Math.max(4, ...rows.map((r) => r.key.length));
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('FLAG', keyW)}  ${pad('STATE', 5)}  ${pad('ORIGIN', 10)}  ${pad('STABILITY', 13)}NAME${C.reset}\n`,
  );
  for (const r of rows) {
    const state = !r.available
      ? `${C.faded}n/a  ${C.reset}`
      : r.enabled
        ? `${C.green}on   ${C.reset}`
        : `${C.dim}off  ${C.reset}`;
    const origin = !r.available ? 'unavailable' : r.overridden ? 'override' : 'default';
    process.stdout.write(
      `  ${pad(r.key, keyW)}  ${state}  ${pad(origin, 10)}  ${pad(r.stability, 13)}${r.name}\n`,
    );
  }
  process.stdout.write('\n');
}

async function projectsFeatures(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(FEATURES_HELP);
    return 0;
  }
  const json = takeFlagBool(rest, ['--json']);
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project', '-p']);
    hostArg = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const sub = rest[0] ?? 'ls';
  const flag = rest[1];

  const ctx = await resolveProjectContext({ projectArg, hostArg });
  if (!ctx) return 1;
  const { client, projectId } = ctx;

  if (sub === 'ls' || sub === 'list') {
    try {
      const project = await client.get<Record<string, unknown>>(`/projects/${projectId}`);
      const rows = featureRows(project);
      if (json) {
        emitJson(rows);
        return 0;
      }
      printFeatureTable(rows);
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  if (sub === 'enable' || sub === 'on' || sub === 'disable' || sub === 'off' || sub === 'reset' || sub === 'clear') {
    if (!flag) {
      process.stderr.write(`${status.err(`features ${sub} requires a <flag>.`)}\n\n${FEATURES_HELP}`);
      return 2;
    }
    const enabled = sub === 'enable' || sub === 'on' ? true : sub === 'disable' || sub === 'off' ? false : null;
    try {
      const project = await client.patch<Record<string, unknown>>(`/projects/${projectId}/features`, {
        feature: flag,
        enabled,
      });
      const row = featureRows(project).find((r) => r.key === flag);
      if (json) {
        emitJson(row ?? { key: flag, enabled });
        return 0;
      }
      const verb = enabled === null ? 'reset to default' : enabled ? 'enabled' : 'disabled';
      const effective = row ? (row.available ? (row.enabled ? 'on' : 'off') : 'unavailable on this host') : '?';
      process.stdout.write(`${status.ok(`${flag} ${verb} — effective: ${effective}`)}\n`);
      if (row && !row.available) {
        process.stdout.write(
          `${status.warn(`${flag} is not available on this host; the override is stored but has no effect.`)}\n`,
        );
      }
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  process.stderr.write(`${status.err(`unknown features subcommand "${sub}"`)}\n\n${FEATURES_HELP}`);
  return 2;
}

export interface ProjectCloneTarget {
  repoUrl: string;
  token: string | null;
  username: string;
  needsManagedToken: boolean;
}

export function saveClonedProjectLink(
  repoRoot: string,
  project: ProjectSummary,
  host: string | undefined,
  hostUrl: string,
): void {
  saveLink(
    {
      project_id: project.project_id,
      account_id: project.account_id,
      host,
      host_url: hostUrl,
      linked_at: new Date().toISOString(),
    },
    repoRoot,
  );

  appendGitExcludeEntries(
    repoRoot,
    ['/.kortix/link.json'],
    'Kortix local project binding',
  );
}

/** Resolve clone auth without ever placing a credential in the remote URL.
 *  Thin adapter over the shared resolver in ../project-git.ts — the same
 *  decision `kortix ship` and the git credential helper make. */
export function resolveProjectCloneTarget(
  project: ProjectSummary,
  kortixToken: string,
): ProjectCloneTarget {
  const target = resolveProjectGitTarget(project);
  return {
    repoUrl: target.repoUrl,
    token: target.credentialMode === "kortix-token" ? kortixToken : null,
    username: "x-access-token",
    needsManagedToken: target.credentialMode === "managed-git-token",
  };
}

async function projectsClone(
  arg?: string,
  destination?: string,
  hostArg?: string,
): Promise<number> {
  const id = arg ?? resolveProjectId();
  if (!id) {
    process.stderr.write(
      `${status.err("No project selected. Run `kortix projects use`, link a directory, or pass an id.")}\n`,
    );
    return 1;
  }

  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix projects clone ${id} --host ${host}`,
  );
  if (!located) return 1;

  const { client, auth, project } = located.located;
  const target = resolveProjectCloneTarget(project, auth.token);
  if (target.needsManagedToken) {
    try {
      const credential = await client.post<{
        push_token: string;
        git_username?: string;
      }>(`/projects/${project.project_id}/git-token`);
      target.token = credential.push_token;
      target.username = credential.git_username || target.username;
    } catch (err) {
      return surface(err);
    }
  }

  const args = target.token
    ? [
        ...authHeaderArgs(target.repoUrl, target.token, target.username),
        "clone",
        target.repoUrl,
      ]
    : ["clone", target.repoUrl];
  if (destination) args.push(destination);

  const cloned = spawnSync("git", args, { stdio: "inherit" });
  if (cloned.error) {
    process.stderr.write(
      `${status.err(`Could not start git: ${cloned.error.message}`)}\n`,
    );
    return 1;
  }
  if ((cloned.status ?? 1) !== 0) {
    process.stderr.write(
      `${status.err(`git clone failed (exit ${cloned.status ?? 1}).`)}\n`,
    );
    return cloned.status ?? 1;
  }

  const defaultDirectory =
    target.repoUrl
      .split("/")
      .pop()
      ?.replace(/\.git$/i, "") || project.name;
  const repoRoot = resolve(process.cwd(), destination || defaultDirectory);
  if (isKortixProject(repoRoot)) {
    saveClonedProjectLink(
      repoRoot,
      project,
      hostArg ?? located.located.hostName ?? activeHostName() ?? undefined,
      auth.api_base,
    );
    if (target.token) configureProjectGitAuth(repoRoot, target.repoUrl);
  }

  process.stdout.write(`${status.ok(`Cloned ${project.name}`)}\n`);
  return 0;
}

function requireAuth() {
  const auth = loadAuth();
  if (!auth?.token) {
    process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    return null;
  }
  return auth;
}

/** The account `projects ls` should be scoped to: the active account, falling
 *  back to the host's stored account id. Undefined lets the server pick its
 *  earliest-joined-account default (pre-feature behavior). */
function scopeAccountId(auth: Auth): string | undefined {
  return activeAccount()?.id ?? auth.account_id ?? undefined;
}

async function projectsLs(json = false, all = false): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;
  if (all) return projectsLsAll(auth, json);

  // Scope to the active account so this lists exactly that account's projects
  // (not the server's earliest-joined-account default).
  const client = clientFromAuth(auth, { accountId: scopeAccountId(auth) });
  let projects: ProjectSummary[];
  try {
    projects = await client.get<ProjectSummary[]>('/projects');
  } catch (err) {
    return surface(err);
  }

  if (json) {
    emitJson(projects);
    return 0;
  }

  const acct = activeAccount();
  const linked = loadLink()?.project_id;
  const def = defaultProject()?.project_id;

  process.stdout.write('\n');
  if (acct) {
    const label = acct.name
      ? `${C.bold}${acct.name}${C.reset} ${C.faded}(${acct.slug})${C.reset}`
      : `${C.bold}${acct.slug}${C.reset}`;
    process.stdout.write(`  ${C.dim}account  ${C.reset}${label}\n\n`);
  }

  if (projects.length === 0) {
    process.stdout.write(`  ${C.dim}No projects in this account.${C.reset}\n\n`);
    return 0;
  }

  renderProjectTable(projects, { linked, def });
  process.stdout.write(
    `\n  ${C.dim}${projects.length} project${projects.length === 1 ? '' : 's'}` +
      `${acct ? ` in ${acct.name || acct.slug}` : ''} · spans all accounts: ${C.reset}` +
      `${C.cyan}kortix projects ls --all${C.reset}\n\n`,
  );
  return 0;
}

async function projectsLsAll(auth: Auth, json = false): Promise<number> {
  let me: MeResponse;
  try {
    me = await clientFromAuth(auth).get<MeResponse>('/accounts/me');
  } catch (err) {
    return surface(err);
  }

  const activeId = activeAccount()?.id ?? auth.account_id;
  const linked = loadLink()?.project_id;
  const def = defaultProject()?.project_id;

  const sections: { account: AccountMembership; projects: ProjectSummary[] }[] = [];
  for (const a of me.accounts) {
    let projects: ProjectSummary[] = [];
    try {
      projects = await clientFromAuth(auth, { accountId: a.account_id }).get<ProjectSummary[]>(
        '/projects',
      );
    } catch {
      /* skip accounts we can't read; leave the section empty */
    }
    sections.push({ account: a, projects });
  }

  if (json) {
    emitJson(
      sections.map((s) => ({
        account: {
          account_id: s.account.account_id,
          slug: s.account.slug,
          name: s.account.name,
          role: s.account.role,
          active: s.account.account_id === activeId,
        },
        projects: s.projects,
      })),
    );
    return 0;
  }

  let total = 0;
  for (const s of sections) {
    const activeMark =
      s.account.account_id === activeId ? `   ${C.green}← active${C.reset}` : '';
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.bold}${s.account.name || s.account.slug}${C.reset} ${C.faded}(${s.account.slug}, ${s.account.role})${C.reset}${activeMark}\n`,
    );
    if (s.projects.length === 0) {
      process.stdout.write(`  ${C.dim}— no projects${C.reset}\n`);
      continue;
    }
    renderProjectTable(s.projects, { linked, def });
    total += s.projects.length;
  }
  process.stdout.write(
    `\n  ${C.dim}${total} project${total === 1 ? '' : 's'} across ${me.accounts.length} ` +
      `account${me.accounts.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

/** Render a project table. `●` marks the global default, `◆` the cwd's
 *  directory link; a trailing tag spells it out. */
function renderProjectTable(
  projects: ProjectSummary[],
  marks: { linked?: string; def?: string },
): void {
  const nameW = Math.max(...projects.map((p) => p.name.length), 4);
  process.stdout.write(
    `  ${C.dim}${pad('NAME', nameW)}   ${pad('REPO', 40)}   BRANCH    UPDATED${C.reset}\n`,
  );
  for (const p of projects) {
    const isDefault = p.project_id === marks.def;
    const isLinked = p.project_id === marks.linked;
    const marker = isDefault
      ? `${C.green}● ${C.reset}`
      : isLinked
        ? `${C.cyan}◆ ${C.reset}`
        : '  ';
    const tag = isDefault
      ? `   ${C.green}default${C.reset}`
      : isLinked
        ? `   ${C.cyan}linked${C.reset}`
        : '';
    const repo = trimMid(p.repo_url, 40);
    const updated = formatRelative(p.updated_at);
    process.stdout.write(
      `${marker}${pad(p.name, nameW)}   ${pad(repo, 40)}   ${pad(p.default_branch, 8)}  ${C.faded}${updated}${C.reset}${tag}\n`,
    );
  }
}

async function projectsInfo(arg?: string, json = false, hostArg?: string): Promise<number> {
  const id = arg ?? resolveProjectId();
  if (!id) {
    process.stderr.write(
      `${status.err('No project linked. Run `kortix projects link` or pass an id.')}\n`,
    );
    return 1;
  }
  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix projects info ${id} --host ${host}`,
  );
  if (!located) return 1;
  const p = located.located.project;
  if (json) {
    emitJson(p);
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${p.name}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}project_id ${C.reset}${p.project_id}\n`);
  process.stdout.write(`  ${C.dim}account_id ${C.reset}${p.account_id}\n`);
  process.stdout.write(`  ${C.dim}repo       ${C.reset}${p.repo_url}\n`);
  process.stdout.write(`  ${C.dim}branch     ${C.reset}${p.default_branch}\n`);
  process.stdout.write(`  ${C.dim}manifest   ${C.reset}${p.manifest_path}\n`);
  process.stdout.write(`  ${C.dim}status     ${C.reset}${p.status}\n`);
  process.stdout.write(`  ${C.dim}updated    ${C.reset}${formatRelative(p.updated_at)}\n\n`);
  return 0;
}

async function projectsUse(arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;

  let target: ProjectSummary | null = null;
  if (arg) {
    // An explicit id may live in any account — resolve it unscoped.
    try {
      target = await clientFromAuth(auth).get<ProjectSummary>(`/projects/${arg}`);
    } catch (err) {
      return surface(err);
    }
  } else {
    // Pick from the active account's projects.
    let list: ProjectSummary[];
    try {
      list = await clientFromAuth(auth, { accountId: scopeAccountId(auth) }).get<ProjectSummary[]>(
        '/projects',
      );
    } catch (err) {
      return surface(err);
    }
    if (list.length === 0) {
      process.stderr.write(
        `${status.err('No projects in the active account.')} Switch with \`kortix accounts use\`.\n`,
      );
      return 1;
    }
    const picked = await selectFromList<ProjectSummary>({
      title: 'Set the global default project',
      items: list.map((p) => ({ value: p, label: p.name, sublabel: p.project_id })),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  if (!target) {
    process.stderr.write(`${status.err('Could not resolve a project.')}\n`);
    return 1;
  }

  // A default project pins its account. If it lives in a different account
  // than the active one, switch the active account to it (resolving the
  // account's display name best-effort) before recording the default.
  const switched = target.account_id !== (activeAccount()?.id ?? auth.account_id);
  let accountLabel = target.account_id.slice(0, 8);
  if (switched) {
    let slug = target.account_id.slice(0, 8);
    let name: string | undefined;
    try {
      const me = await clientFromAuth(auth).get<MeResponse>('/accounts/me');
      const m = me.accounts.find((a) => a.account_id === target!.account_id);
      if (m) {
        slug = m.slug;
        name = m.name;
      }
    } catch {
      /* fall back to the truncated id */
    }
    setActiveAccount({ id: target.account_id, slug, name });
    accountLabel = name ? `${name} (${slug})` : slug;
  }
  setDefaultProject({
    project_id: target.project_id,
    account_id: target.account_id,
    name: target.name,
  });

  process.stdout.write(`${status.ok(`Default project: ${C.bold}${target.name}${C.reset}`)}\n`);
  if (switched) {
    process.stdout.write(`  ${C.dim}account → ${C.reset}${accountLabel} ${C.dim}(now active)${C.reset}\n`);
  }
  process.stdout.write(
    `  ${C.dim}Used by connectors/connections/sessions when a directory isn't linked.${C.reset}\n`,
  );
  return 0;
}

async function projectsUnset(): Promise<number> {
  const existing = defaultProject();
  if (clearDefaultProject()) {
    process.stdout.write(
      `${status.ok(`Cleared the default project${existing?.name ? ` ${C.dim}(was ${existing.name})${C.reset}` : ''}`)}\n`,
    );
  } else {
    process.stdout.write(`${C.dim}No default project set. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function projectsLink(arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;

  // Refuse to scatter `.kortix/link.json` into random directories. A
  // project is only "Kortix-linkable" if it already has a `.kortix/`
  // dir (from `kortix init`) or a `kortix.yaml` at the root.
  if (!isKortixProject()) {
    process.stderr.write(
      `${status.err(`Not a Kortix project — no .kortix/ or kortix.yaml in ${process.cwd()}.`)}\n`,
    );
    process.stderr.write(
      `  ${C.dim}Run ${C.reset}${C.cyan}kortix init${C.reset}${C.dim} here first to scaffold one.${C.reset}\n`,
    );
    return 1;
  }

  const client = clientFromAuth(auth);

  let target: ProjectSummary | null = null;
  if (arg) {
    try {
      target = await client.get<ProjectSummary>(`/projects/${arg}`);
    } catch (err) {
      return surface(err);
    }
  } else {
    let list: ProjectSummary[];
    try {
      list = await client.get<ProjectSummary[]>('/projects');
    } catch (err) {
      return surface(err);
    }
    if (list.length === 0) {
      process.stderr.write(`${status.err('No projects in this account to link to.')}\n`);
      return 1;
    }
    const picked = await selectFromList<ProjectSummary>({
      title: `Pick a project to link to ${process.cwd()}`,
      items: list.map((p) => ({
        value: p,
        label: p.name,
        sublabel: p.project_id,
      })),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  if (!target) {
    process.stderr.write(`${status.err('Could not resolve a project.')}\n`);
    return 1;
  }

  const hostName = activeHostName() ?? 'default';
  saveLink({
    project_id: target.project_id,
    account_id: target.account_id,
    host: hostName,
    host_url: auth.api_base,
    linked_at: new Date().toISOString(),
  });
  process.stdout.write(
    `${status.ok(`Linked ${C.bold}${target.name}${C.reset}${C.dim} → .kortix/link.json${C.reset}`)}\n`,
  );
  process.stdout.write(
    `  ${C.dim}host:       ${C.reset}${hostName} ${C.faded}(${auth.api_base})${C.reset}\n`,
  );
  process.stdout.write(`  ${C.dim}project_id: ${C.reset}${target.project_id}\n`);
  return 0;
}

async function projectsUnlink(): Promise<number> {
  const existing = loadLink();
  clearLink();
  if (existing) {
    process.stdout.write(`${status.ok(`Unlinked ${C.dim}(was ${existing.project_id})${C.reset}`)}\n`);
  } else {
    process.stdout.write(`${C.dim}Not linked. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function projectsOpen(arg?: string, hostArg?: string): Promise<number> {
  const id = arg ?? resolveProjectId();
  if (!id) {
    process.stderr.write(`${status.err('No project linked. Pass an id or link first.')}\n`);
    return 1;
  }
  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix projects open ${id} --host ${host}`,
  );
  if (!located) return 1;
  const url = projectWebUrl(located.located.auth.api_base, id);
  process.stdout.write(`${C.dim}Opening ${url}${C.reset}\n`);
  openInBrowser(url);
  return 0;
}

interface RmResult {
  ok: boolean;
  archived: boolean;
  repo_deleted: boolean;
}

async function projectsRm(args: string[]): Promise<number> {
  const rest = [...args];
  const purge = takeFlagBool(rest, ['--purge']);
  const yes = takeFlagBool(rest, ['-y', '--yes']);
  let hostArg: string | undefined;
  try {
    hostArg = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const id = rest.find((a) => !a.startsWith('-')) ?? resolveProjectId();
  if (!id) {
    process.stderr.write(
      `${status.err('No project to remove.')} Pass an id or run inside a linked project.\n`,
    );
    return 1;
  }

  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix projects rm ${id} --host ${host}`,
  );
  if (!located) return 1;
  const { client, project } = located.located;

  if (!yes) {
    const msg = purge
      ? `Archive ${C.bold}${project.name}${C.reset} AND permanently delete its managed git repo? ${C.red}This cannot be undone.${C.reset}`
      : `Archive ${C.bold}${project.name}${C.reset}? (the git repo is kept; pass --purge to delete it)`;
    const ok = await confirm(msg, false);
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }

  let result: RmResult;
  try {
    result = await client.delete<RmResult>(`/projects/${id}${purge ? '?purge=true' : ''}`);
  } catch (err) {
    return surface(err);
  }

  // Drop the local binding if we just removed the linked project.
  if (loadLink()?.project_id === id) clearLink();

  process.stdout.write(`${status.ok(`Archived ${C.bold}${project.name}${C.reset}`)}\n`);
  if (purge) {
    process.stdout.write(
      result.repo_deleted
        ? `  ${C.dim}managed git repo deleted${C.reset}\n`
        : `  ${C.dim}no managed repo to delete (bring-your-own repos are left untouched)${C.reset}\n`,
    );
  }
  return 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

function surface(err: unknown): number {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(
        `${status.err('Token rejected. Run `kortix login` to re-authenticate.')}\n`,
      );
    } else {
      process.stderr.write(`${status.err(`HTTP ${err.status}: ${err.message}`)}\n`);
    }
    return 1;
  }
  process.stderr.write(`${status.err((err as Error).message)}\n`);
  return 1;
}

function trimMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
