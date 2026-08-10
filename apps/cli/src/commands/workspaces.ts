import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Auth } from '../api/auth.ts';
import { loadAuth } from '../api/auth.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import {
  activeAccount,
  activeHostName,
  clearDefaultWorkspace,
  defaultWorkspace,
  setActiveAccount,
  setDefaultWorkspace,
} from '../api/config.ts';
import type { AccountMembership, MeResponse, WorkspaceSummary } from '../api/types.ts';
import {
  emitJson,
  locateWorkspaceAnywhere,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { appendGitExcludeEntries } from '../git-exclude.ts';
import { configureWorkspaceGitAuth, resolveWorkspaceGitTarget } from '../workspace-git.ts';
import {
  clearWorkspaceLink,
  isKortixWorkspace,
  loadWorkspaceLink,
  resolveWorkspaceId,
  saveWorkspaceLink,
} from '../workspace-link.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';
import { selectFromList } from '../tui-select.ts';
import { workspaceWebUrl } from '../web-url.ts';
import { authHeaderArgs } from './ship.ts';

/** Back-compat alias — the helper moved to ../workspace-git.ts so `ship` can use
 *  it without an import cycle through this command module. */
export {
  configureWorkspaceGitAuth as configureClonedWorkspaceAuth,
  currentGitCredentialHelperCommand,
} from '../workspace-git.ts';

export interface WorkspaceDomain {
  command: 'workspaces' | 'projects';
  route: '/workspaces' | '/projects';
  singular: 'workspace' | 'project';
  plural: 'workspaces' | 'projects';
  title: 'Workspace' | 'Project';
  normalize: (value: unknown) => WorkspaceSummary;
  toWire: (workspace: WorkspaceSummary) => unknown;
  webUrl: typeof workspaceWebUrl;
}

const WORKSPACE_DOMAIN: WorkspaceDomain = {
  command: 'workspaces',
  route: '/workspaces',
  singular: 'workspace',
  plural: 'workspaces',
  title: 'Workspace',
  normalize: (value) => value as WorkspaceSummary,
  toWire: (workspace) => workspace,
  webUrl: workspaceWebUrl,
};

function commandHelp(domain: WorkspaceDomain): string {
  return help`Usage: kortix ${domain.command} <subcommand>

Subcommands:
  ls [--all]           List ${domain.plural} in the active account (--all spans every
                       account, grouped). (--json)
  info [<id>]          Show one ${domain.singular} (defaults to the linked/default) (--json)
  use [<id>]           Set the global DEFAULT ${domain.singular} (interactive if omitted).
                       Switches the active account to the ${domain.singular}'s account.
  unset                Clear the global default ${domain.singular}.
  link [<id>]          Bind cwd to a remote ${domain.singular} (writes .kortix/link.json)
  unlink               Remove .kortix/link.json from cwd
  open [<id>]          Open the dashboard URL for one ${domain.singular}
  clone [<id>] [dir]   Clone through the authenticated Kortix git proxy. Falls
                       back to your local Git credentials for direct BYO repos.
  rm [<id>]            Archive a ${domain.singular} (defaults to the linked one).
                       --purge also deletes its managed git repo (irreversible).
                       -y / --yes skips the confirmation.

An explicit <id> on info/open/rm resolves on its own: tries the active host
first, then — unless you pass --host — scans every other logged-in host for
it. A directory link (.kortix/link.json) always wins over the default; the
default is what commands use anywhere else on your machine.

Run \`kortix ${domain.command} <subcommand> --help\` for options.
`;
}

export async function runWorkspaces(argv: string[]): Promise<number> {
  return runWorkspaceDomain(argv, WORKSPACE_DOMAIN);
}

export async function runWorkspaceDomain(
  argv: string[],
  domain: WorkspaceDomain,
): Promise<number> {
  const commandHelpText = commandHelp(domain);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(commandHelpText);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // None of the subcommands below own dedicated help text or parse
  // -h/--help themselves, so without this a bare `--help` falls through as
  // an ordinary positional arg — e.g. `workspaces info --help` would try to
  // look up a workspace literally named "--help", and `workspaces rm --help`
  // would silently fall back to archiving the DEFAULT workspace instead of
  // showing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(commandHelpText);
    return 0;
  }
  switch (sub) {
    case 'ls':
    case 'list': {
      const restCopy = [...rest];
      const all = takeFlagBool(restCopy, ['--all', '-a']);
      const json = takeFlagBool(restCopy, ['--json']);
      return workspacesLs(domain, json, all);
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
      return workspacesInfo(domain, restCopy[0], json, hostArg);
    }
    case 'use':
    case 'default':
      return workspacesUse(domain, rest.find((a) => !a.startsWith('-')));
    case 'unset':
    case 'clear':
      return workspacesUnset(domain);
    case 'link':
      return workspacesLink(domain, rest[0]);
    case 'unlink':
      return workspacesUnlink();
    case 'open': {
      const restCopy = [...rest];
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return workspacesOpen(domain, restCopy[0], hostArg);
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
      return workspacesClone(domain, restCopy[0], restCopy[1], hostArg);
    }
    case 'rm':
    case 'remove':
      return workspacesRm(domain, rest);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${commandHelpText}`);
      return 2;
  }
}

export interface WorkspaceCloneTarget {
  repoUrl: string;
  token: string | null;
  username: string;
  needsManagedToken: boolean;
}

export function saveClonedWorkspaceLink(
  repoRoot: string,
  workspace: WorkspaceSummary,
  host: string | undefined,
  hostUrl: string,
): void {
  saveWorkspaceLink(
    {
      workspace_id: workspace.workspace_id,
      account_id: workspace.account_id,
      host,
      host_url: hostUrl,
      linked_at: new Date().toISOString(),
    },
    repoRoot,
  );

  appendGitExcludeEntries(
    repoRoot,
    ['/.kortix/link.json'],
    'Kortix local workspace binding',
  );
}

/** Resolve clone auth without ever placing a credential in the remote URL.
 *  Thin adapter over the shared resolver in ../workspace-git.ts — the same
 *  decision `kortix ship` and the git credential helper make. */
export function resolveWorkspaceCloneTarget(
  workspace: WorkspaceSummary,
  kortixToken: string,
): WorkspaceCloneTarget {
  const target = resolveWorkspaceGitTarget(workspace);
  return {
    repoUrl: target.repoUrl,
    token: target.credentialMode === "kortix-token" ? kortixToken : null,
    username: "x-access-token",
    needsManagedToken: target.credentialMode === "managed-git-token",
  };
}

async function workspacesClone(
  domain: WorkspaceDomain,
  arg?: string,
  destination?: string,
  hostArg?: string,
): Promise<number> {
  const id = arg ?? resolveWorkspaceId();
  if (!id) {
    process.stderr.write(
      `${status.err(`No ${domain.singular} selected. Run \`kortix ${domain.command} use\`, link a directory, or pass an id.`)}\n`,
    );
    return 1;
  }

  const located = await locateWorkspaceAnywhere(
    id,
    { hostArg, route: domain.route, normalize: domain.normalize },
    (host) => `kortix ${domain.command} clone ${id} --host ${host}`
  );
  if (!located) return 1;

  const { client, auth, workspace } = located.located;
  const target = resolveWorkspaceCloneTarget(workspace, auth.token);
  if (target.needsManagedToken) {
    try {
      const credential = await client.post<{
        push_token: string;
        git_username?: string;
      }>(`${domain.route}/${workspace.workspace_id}/git-token`);
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
      ?.replace(/\.git$/i, "") || workspace.name;
  const repoRoot = resolve(process.cwd(), destination || defaultDirectory);
  if (isKortixWorkspace(repoRoot)) {
    saveClonedWorkspaceLink(
      repoRoot,
      workspace,
      hostArg ?? located.located.hostName ?? activeHostName() ?? undefined,
      auth.api_base,
    );
    if (target.token) configureWorkspaceGitAuth(repoRoot, target.repoUrl);
  }

  process.stdout.write(`${status.ok(`Cloned ${workspace.name}`)}\n`);
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

/** The account `workspaces ls` should be scoped to: the active account, falling
 *  back to the host's stored account id. Undefined lets the server pick its
 *  earliest-joined-account default (pre-feature behavior). */
function scopeAccountId(auth: Auth): string | undefined {
  return activeAccount()?.id ?? auth.account_id ?? undefined;
}

async function workspacesLs(domain: WorkspaceDomain, json = false, all = false): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;
  if (all) return workspacesLsAll(domain, auth, json);

  // Scope to the active account so this lists exactly that account's workspaces
  // (not the server's earliest-joined-account default).
  const client = clientFromAuth(auth, { accountId: scopeAccountId(auth) });
  let workspaces: WorkspaceSummary[];
  try {
    const response = await client.get<unknown[]>(domain.route);
    workspaces = response.map(domain.normalize);
  } catch (err) {
    return surface(err);
  }

  if (json) {
    emitJson(workspaces.map(domain.toWire));
    return 0;
  }

  const acct = activeAccount();
  const linked = loadWorkspaceLink()?.workspace_id;
  const def = defaultWorkspace()?.workspace_id;

  process.stdout.write('\n');
  if (acct) {
    const label = acct.name
      ? `${C.bold}${acct.name}${C.reset} ${C.faded}(${acct.slug})${C.reset}`
      : `${C.bold}${acct.slug}${C.reset}`;
    process.stdout.write(`  ${C.dim}account  ${C.reset}${label}\n\n`);
  }

  if (workspaces.length === 0) {
    process.stdout.write(`  ${C.dim}No ${domain.plural} in this account.${C.reset}\n\n`);
    return 0;
  }

  renderWorkspaceTable(workspaces, { linked, def });
  process.stdout.write(
    `\n  ${C.dim}${workspaces.length} ${domain.singular}${workspaces.length === 1 ? '' : 's'}` +
      `${acct ? ` in ${acct.name || acct.slug}` : ''} · spans all accounts: ${C.reset}` +
      `${C.cyan}kortix ${domain.command} ls --all${C.reset}\n\n`,
  );
  return 0;
}

async function workspacesLsAll(domain: WorkspaceDomain, auth: Auth, json = false): Promise<number> {
  let me: MeResponse;
  try {
    me = await clientFromAuth(auth).get<MeResponse>('/accounts/me');
  } catch (err) {
    return surface(err);
  }

  const activeId = activeAccount()?.id ?? auth.account_id;
  const linked = loadWorkspaceLink()?.workspace_id;
  const def = defaultWorkspace()?.workspace_id;

  const sections: { account: AccountMembership; workspaces: WorkspaceSummary[] }[] = [];
  for (const a of me.accounts) {
    let workspaces: WorkspaceSummary[] = [];
    try {
      const response = await clientFromAuth(auth, {
        accountId: a.account_id,
      }).get<unknown[]>(domain.route);
      workspaces = response.map(domain.normalize);
    } catch {
      /* skip accounts we can't read; leave the section empty */
    }
    sections.push({ account: a, workspaces });
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
        [domain.plural]: s.workspaces.map(domain.toWire),
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
    if (s.workspaces.length === 0) {
      process.stdout.write(`  ${C.dim}— no ${domain.plural}${C.reset}\n`);
      continue;
    }
    renderWorkspaceTable(s.workspaces, { linked, def });
    total += s.workspaces.length;
  }
  process.stdout.write(
    `\n  ${C.dim}${total} ${domain.singular}${total === 1 ? '' : 's'} across ${me.accounts.length} ` +
      `account${me.accounts.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

/** Render a workspace table. `●` marks the global default, `◆` the cwd's
 *  directory link; a trailing tag spells it out. */
function renderWorkspaceTable(
  workspaces: WorkspaceSummary[],
  marks: { linked?: string; def?: string },
): void {
  const nameW = Math.max(...workspaces.map((p) => p.name.length), 4);
  process.stdout.write(
    `  ${C.dim}${pad('NAME', nameW)}   ${pad('REPO', 40)}   BRANCH    UPDATED${C.reset}\n`,
  );
  for (const p of workspaces) {
    const isDefault = p.workspace_id === marks.def;
    const isLinked = p.workspace_id === marks.linked;
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

async function workspacesInfo(
  domain: WorkspaceDomain,
  arg?: string,
  json = false,
  hostArg?: string,
): Promise<number> {
  const id = arg ?? resolveWorkspaceId();
  if (!id) {
    process.stderr.write(
      `${status.err(`No ${domain.singular} linked. Run \`kortix ${domain.command} link\` or pass an id.`)}\n`,
    );
    return 1;
  }
  const located = await locateWorkspaceAnywhere(
    id,
    { hostArg, route: domain.route, normalize: domain.normalize },
    (host) => `kortix ${domain.command} info ${id} --host ${host}`
  );
  if (!located) return 1;
  const p = located.located.workspace;
  if (json) {
    emitJson(domain.toWire(p));
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${p.name}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}${domain.singular}_id ${C.reset}${p.workspace_id}\n`);
  process.stdout.write(`  ${C.dim}account_id ${C.reset}${p.account_id}\n`);
  process.stdout.write(`  ${C.dim}repo       ${C.reset}${p.repo_url}\n`);
  process.stdout.write(`  ${C.dim}branch     ${C.reset}${p.default_branch}\n`);
  process.stdout.write(`  ${C.dim}manifest   ${C.reset}${p.manifest_path}\n`);
  process.stdout.write(`  ${C.dim}status     ${C.reset}${p.status}\n`);
  process.stdout.write(`  ${C.dim}updated    ${C.reset}${formatRelative(p.updated_at)}\n\n`);
  return 0;
}

async function workspacesUse(domain: WorkspaceDomain, arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;

  let target: WorkspaceSummary | null = null;
  if (arg) {
    // An explicit id may live in any account — resolve it unscoped.
    try {
      target = domain.normalize(await clientFromAuth(auth).get<unknown>(`${domain.route}/${arg}`));
    } catch (err) {
      return surface(err);
    }
  } else {
    // Pick from the active account's workspaces.
    let list: WorkspaceSummary[];
    try {
      const response = await clientFromAuth(auth, {
        accountId: scopeAccountId(auth),
      }).get<unknown[]>(domain.route);
      list = response.map(domain.normalize);
    } catch (err) {
      return surface(err);
    }
    if (list.length === 0) {
      process.stderr.write(
        `${status.err(`No ${domain.plural} in the active account.`)} Switch with \`kortix accounts use\`.\n`,
      );
      return 1;
    }
    const picked = await selectFromList<WorkspaceSummary>({
      title: `Set the global default ${domain.singular}`,
      items: list.map((p) => ({
        value: p,
        label: p.name,
        sublabel: p.workspace_id,
      })),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  if (!target) {
    process.stderr.write(`${status.err(`Could not resolve a ${domain.singular}.`)}\n`);
    return 1;
  }

  // A default workspace pins its account. If it lives in a different account
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
  setDefaultWorkspace({
    workspace_id: target.workspace_id,
    account_id: target.account_id,
    name: target.name,
  });

  process.stdout.write(`${status.ok(`Default ${domain.singular}: ${C.bold}${target.name}${C.reset}`)}\n`);
  if (switched) {
    process.stdout.write(`  ${C.dim}account → ${C.reset}${accountLabel} ${C.dim}(now active)${C.reset}\n`);
  }
  process.stdout.write(
    `  ${C.dim}Used by connectors/connections/sessions when a directory isn't linked.${C.reset}\n`,
  );
  return 0;
}

async function workspacesUnset(domain: WorkspaceDomain): Promise<number> {
  const existing = defaultWorkspace();
  if (clearDefaultWorkspace()) {
    process.stdout.write(
      `${status.ok(`Cleared the default ${domain.singular}${existing?.name ? ` ${C.dim}(was ${existing.name})${C.reset}` : ''}`)}\n`,
    );
  } else {
    process.stdout.write(`${C.dim}No default ${domain.singular} set. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function workspacesLink(domain: WorkspaceDomain, arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;

  // Refuse to scatter `.kortix/link.json` into random directories. A
  // workspace is only "Kortix-linkable" if it already has a `.kortix/`
  // dir (from `kortix init`) or a `kortix.yaml` at the root.
  if (!isKortixWorkspace()) {
    process.stderr.write(
      `${status.err(`Not a Kortix ${domain.singular} — no .kortix/ or kortix.yaml in ${process.cwd()}.`)}\n`,
    );
    process.stderr.write(
      `  ${C.dim}Run ${C.reset}${C.cyan}kortix init${C.reset}${C.dim} here first to scaffold one.${C.reset}\n`,
    );
    return 1;
  }

  const client = clientFromAuth(auth);

  let target: WorkspaceSummary | null = null;
  if (arg) {
    try {
      target = domain.normalize(await client.get<unknown>(`${domain.route}/${arg}`));
    } catch (err) {
      return surface(err);
    }
  } else {
    let list: WorkspaceSummary[];
    try {
      const response = await client.get<unknown[]>(domain.route);
      list = response.map(domain.normalize);
    } catch (err) {
      return surface(err);
    }
    if (list.length === 0) {
      process.stderr.write(`${status.err(`No ${domain.plural} in this account to link to.`)}\n`);
      return 1;
    }
    const picked = await selectFromList<WorkspaceSummary>({
      title: `Pick a ${domain.singular} to link to ${process.cwd()}`,
      items: list.map((p) => ({
        value: p,
        label: p.name,
        sublabel: p.workspace_id,
      })),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  if (!target) {
    process.stderr.write(`${status.err(`Could not resolve a ${domain.singular}.`)}\n`);
    return 1;
  }

  const hostName = activeHostName() ?? 'default';
  saveWorkspaceLink({
    workspace_id: target.workspace_id,
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
  process.stdout.write(`  ${C.dim}${domain.singular}_id: ${C.reset}${target.workspace_id}\n`);
  return 0;
}

async function workspacesUnlink(): Promise<number> {
  const existing = loadWorkspaceLink();
  clearWorkspaceLink();
  if (existing) {
    process.stdout.write(`${status.ok(`Unlinked ${C.dim}(was ${existing.workspace_id})${C.reset}`)}\n`);
  } else {
    process.stdout.write(`${C.dim}Not linked. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function workspacesOpen(domain: WorkspaceDomain, arg?: string, hostArg?: string): Promise<number> {
  const id = arg ?? resolveWorkspaceId();
  if (!id) {
    process.stderr.write(`${status.err(`No ${domain.singular} linked. Pass an id or link first.`)}\n`);
    return 1;
  }
  const located = await locateWorkspaceAnywhere(
    id,
    { hostArg, route: domain.route, normalize: domain.normalize },
    (host) => `kortix ${domain.command} open ${id} --host ${host}`
  );
  if (!located) return 1;
  const url = domain.webUrl(located.located.auth.api_base, id);
  process.stdout.write(`${C.dim}Opening ${url}${C.reset}\n`);
  openInBrowser(url);
  return 0;
}

interface RmResult {
  ok: boolean;
  archived: boolean;
  repo_deleted: boolean;
}

async function workspacesRm(domain: WorkspaceDomain, args: string[]): Promise<number> {
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
  const id = rest.find((a) => !a.startsWith('-')) ?? resolveWorkspaceId();
  if (!id) {
    process.stderr.write(
      `${status.err(`No ${domain.singular} to remove.`)} Pass an id or run inside a linked ${domain.singular}.\n`,
    );
    return 1;
  }

  const located = await locateWorkspaceAnywhere(
    id,
    { hostArg, route: domain.route, normalize: domain.normalize },
    (host) => `kortix ${domain.command} rm ${id} --host ${host}`
  );
  if (!located) return 1;
  const { client, workspace } = located.located;

  if (!yes) {
    const msg = purge
      ? `Archive ${C.bold}${workspace.name}${C.reset} AND permanently delete its managed git repo? ${C.red}This cannot be undone.${C.reset}`
      : `Archive ${C.bold}${workspace.name}${C.reset}? (the git repo is kept; pass --purge to delete it)`;
    const ok = await confirm(msg, false);
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }

  let result: RmResult;
  try {
    result = await client.delete<RmResult>(`${domain.route}/${id}${purge ? '?purge=true' : ''}`);
  } catch (err) {
    return surface(err);
  }

  // Drop the local binding if we just removed the linked workspace.
  if (loadWorkspaceLink()?.workspace_id === id) clearWorkspaceLink();

  process.stdout.write(`${status.ok(`Archived ${C.bold}${workspace.name}${C.reset}`)}\n`);
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

function openInBrowser(url: string): void {
  // Only hand a real web URL to the OS opener — a value starting with '-' would
  // be read as a flag by open/xdg-open, and Windows `start` parses its argument,
  // so an unvalidated URL is a command-injection vector.
  if (!/^https?:\/\//i.test(url)) return;
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}
