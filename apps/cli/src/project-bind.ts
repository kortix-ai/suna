import type { Auth } from './api/auth.ts';
import { clientFromAuth } from './api/client.ts';
import { NO_WORKSPACE_LINE } from './api/no-workspace.ts';
import {
  activeAccount,
  defaultProject,
  setActiveAccount,
  setDefaultProject,
  type DefaultProjectRef,
} from './api/config.ts';
import { selectFromList } from './tui-select.ts';
import { C, status } from './style.ts';
import type { AccountMembership, MeResponse, ProjectSummary } from './api/types.ts';

export interface BindOutcome {
  project: DefaultProjectRef | null;
  /** True when setDefaultProject was called during this invocation. */
  bound: boolean;
}

/** One workspace: a project and the account membership that owns it. */
export interface WorkspaceRow {
  project: ProjectSummary;
  account: AccountMembership;
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function bindableAccountId(auth: Auth): string | undefined {
  return activeAccount()?.id ?? auth.account_id ?? undefined;
}

/** One account whose project list could not be read. */
export interface WorkspaceListFailure {
  account: AccountMembership;
  error: unknown;
}

/** The workspace a workspace-bound credential (a workspace key, a session or
 *  agent token) is bound to, from `/accounts/me`. Null for a person credential. */
export function boundWorkspaceId(me: MeResponse): string | null {
  return me.token_context?.workspace_id || me.token_context?.project_id || null;
}

/** The membership row that owns one workspace, or a stand-in for a server
 *  that does not report `workspace_id` on its memberships. */
function membershipOf(me: MeResponse, project: ProjectSummary): AccountMembership {
  const accounts = Array.isArray(me.accounts) ? me.accounts : [];
  const owner =
    accounts.find((a) => a.workspace_id && a.workspace_id === project.project_id) ??
    accounts.find((a) => a.account_id === project.account_id);
  const base = owner ?? {
    account_id: project.account_id,
    slug: (project.account_id ?? '').slice(0, 8),
    name: '',
    role: '',
  };
  return project.role ? { ...base, role: project.role } : base;
}

/**
 * Every workspace the caller belongs to on one host, flat: one row per
 * workspace, across every account.
 *
 * - A workspace-bound credential lists its one workspace
 *   (`GET /v1/workspaces/<bound id>`). It never reads another account's list.
 * - A server that lists every workspace in one request (`GET /v1/workspaces`
 *   rows carry `state`) is read once.
 * - An older server is read per account (`/workspaces?account_id=`): a legacy
 *   account with several projects shows each as its own workspace; an account
 *   with no project gives no row.
 *
 * `accountId` narrows to one account (per-account read only).
 *
 * Throws when the identity read (`/accounts/me`) fails, or when the one
 * account asked for cannot be read. One unreadable account among several
 * cannot hide the others: its rows are absent and it is listed in `failed`.
 */
export async function listWorkspaceRowsReport(
  auth: Auth,
  accountId?: string,
  knownMe?: MeResponse,
): Promise<{ rows: WorkspaceRow[]; failed: WorkspaceListFailure[] }> {
  const me = knownMe ?? (await clientFromAuth(auth).get<MeResponse>('/me'));
  const memberships = Array.isArray(me.accounts) ? me.accounts : [];

  const bound = boundWorkspaceId(me);
  if (bound && !accountId) {
    try {
      const project = await clientFromAuth(auth).get<ProjectSummary>(
        `/workspaces/${encodeURIComponent(bound)}`,
      );
      return { rows: [{ project, account: membershipOf(me, project) }], failed: [] };
    } catch (error) {
      const account = memberships.find((a) => a.workspace_id === bound) ?? {
        account_id: bound,
        slug: bound.slice(0, 8),
        name: '',
        role: '',
      };
      return { rows: [], failed: [{ account, error }] };
    }
  }

  if (!accountId && memberships.length > 0) {
    // One request on a server that lists every workspace of the caller.
    // An older server answers this unscoped call with ONE account's projects
    // (no `state` field), so only a row set that carries `state` counts.
    try {
      const listed = await clientFromAuth(auth).get<ProjectSummary[]>('/workspaces');
      if (Array.isArray(listed) && listed.length > 0 && listed.every((p) => typeof p.state === 'string')) {
        return { rows: listed.map((project) => ({ project, account: membershipOf(me, project) })), failed: [] };
      }
    } catch {
      // Fall through to the per-account read, which names each failure.
    }
  }

  const accounts = accountId
    ? memberships.filter((a) => a.account_id === accountId)
    : memberships;
  if (accountId && accounts.length === 0) {
    accounts.push({ account_id: accountId, slug: accountId.slice(0, 8), name: '', role: '' });
  }
  const failed: WorkspaceListFailure[] = [];
  const lists = await Promise.all(
    accounts.map(async (account) => {
      try {
        const projects = await clientFromAuth(auth, { accountId: account.account_id }).get<
          ProjectSummary[]
        >('/workspaces');
        return { account, projects: Array.isArray(projects) ? projects : [] };
      } catch (err) {
        if (accountId) throw err;
        failed.push({ account, error: err });
        return { account, projects: [] as ProjectSummary[] };
      }
    }),
  );
  const rows: WorkspaceRow[] = [];
  const seen = new Set<string>();
  for (const { account, projects } of lists) {
    for (const project of projects) {
      // An older server may answer an account-scoped list unscoped: keep each
      // project once.
      if (seen.has(project.project_id)) continue;
      seen.add(project.project_id);
      rows.push({ project, account: project.role ? { ...account, role: project.role } : account });
    }
  }
  return { rows, failed };
}

/** The reads behind an empty workspace list failed: never "no workspace". */
export class WorkspaceListError extends Error {
  constructor(readonly failed: WorkspaceListFailure[]) {
    const first = failed[0];
    const reason =
      first?.error instanceof Error ? first.error.message : String(first?.error ?? 'unknown error');
    super(
      `could not list the workspaces${failed.length > 1 ? ` of ${failed.length} accounts` : ''}: ${reason}`,
    );
    this.name = 'WorkspaceListError';
  }
}

/** The rows of listWorkspaceRowsReport. Binding picks among the readable
 *  workspaces, so an unreadable account is skipped here, but an empty list
 *  whose reads failed throws WorkspaceListError instead of reading as none. */
export async function listWorkspaceRows(
  auth: Auth,
  accountId?: string,
  knownMe?: MeResponse,
): Promise<WorkspaceRow[]> {
  const report = await listWorkspaceRowsReport(auth, accountId, knownMe);
  if (report.rows.length === 0 && report.failed.length > 0) throw new WorkspaceListError(report.failed);
  return report.rows;
}

/**
 * The workspaces to bind from: the flat list, or — when the identity read is
 * not available (an older server) — the active account's projects.
 */
async function bindableWorkspaces(auth: Auth, accountId?: string): Promise<WorkspaceRow[]> {
  try {
    return await listWorkspaceRows(auth, accountId);
  } catch (err) {
    if (err instanceof WorkspaceListError) throw err;
    const projects = await clientFromAuth(auth, { accountId: accountId ?? bindableAccountId(auth) }).get<
      ProjectSummary[]
    >('/workspaces');
    return projects.map((project) => ({
      project,
      account: { account_id: project.account_id, slug: project.account_id.slice(0, 8), name: '', role: '' },
    }));
  }
}

/**
 * The always-bound invariant: make sure the active host has a global
 * default workspace, creating the binding interactively when possible.
 *
 *   - already bound          → return it, do nothing
 *   - zero workspaces        → the create-or-join line, return null
 *   - exactly one workspace  → bind it automatically (no prompt)
 *   - several + TTY          → picker (Esc skips)
 *   - several + non-TTY      → hint, return null
 *
 * Binding a workspace of another account also makes that account active.
 *
 * Never throws: any API failure degrades to "not bound" with the reason
 * on stderr, so callers (login epilogue, unbound-command recovery) can
 * fall back to their existing error paths.
 */
export async function ensureDefaultProjectBinding(
  auth: Auth,
  opts: {
    promptTitle?: string;
    /** Bind only a workspace of this account (`kortix login --account`). */
    accountId?: string;
    /**
     * Say nothing on ANY path that ends without a bound workspace — none at
     * all, a failed list, a declined picker, a non-TTY with several to choose
     * from.
     *
     * For a caller that has a FALLBACK — `locateSessionAnywhere` scans the
     * other hosts next — the "no workspace" note is not the outcome, it is a
     * step. Printing it announces a failure that is about to be recovered
     * from, which reads as the command having failed even when it goes on to
     * succeed.
     */
    quiet?: boolean;
  } = {},
): Promise<BindOutcome> {
  const existing = defaultProject();
  if (existing) return { project: existing, bound: false };

  let rows: WorkspaceRow[];
  try {
    rows = await bindableWorkspaces(auth, opts.accountId);
  } catch (err) {
    if (!opts.quiet) {
      process.stderr.write(
        `${C.dim}Could not list workspaces to bind a default: ${(err as Error).message}${C.reset}\n`,
      );
    }
    return { project: null, bound: false };
  }

  if (rows.length === 0) {
    if (!opts.quiet) process.stderr.write(`${status.info(NO_WORKSPACE_LINE)}\n`);
    return { project: null, bound: false };
  }

  let picked: WorkspaceRow | null = null;
  if (rows.length === 1) {
    picked = rows[0];
  } else if (isInteractive()) {
    picked = await selectFromList<WorkspaceRow>({
      title: opts.promptTitle ?? 'Pick your default workspace',
      items: rows.map((r) => ({
        value: r,
        label: r.project.name,
        sublabel: r.account.role ? `${r.account.role} · ${r.project.project_id}` : r.project.project_id,
      })),
    });
    if (!picked) {
      if (!opts.quiet) {
        process.stderr.write(
          `${C.dim}Skipped. Pick one any time with ${C.reset}${C.cyan}kortix workspaces use${C.reset}${C.dim}.${C.reset}\n`,
        );
      }
      return { project: null, bound: false };
    }
  } else {
    if (!opts.quiet) {
      process.stderr.write(
        `${C.dim}No default workspace. Run ${C.reset}${C.cyan}kortix workspaces use${C.reset}${C.dim} to pick one.${C.reset}\n`,
      );
    }
    return { project: null, bound: false };
  }

  const { project, account } = picked;
  // The default workspace pins its account: switching it here keeps the
  // active account and the default in the same workspace.
  if (project.account_id && activeAccount()?.id !== project.account_id && account.name) {
    setActiveAccount({ id: project.account_id, slug: account.slug, name: account.name });
  }
  const ref: DefaultProjectRef = {
    project_id: project.project_id,
    account_id: project.account_id,
    name: project.name,
  };
  setDefaultProject(ref);
  process.stderr.write(
    `${status.ok(`Default workspace: ${C.bold}${project.name}${C.reset}`)} ${C.dim}(change with \`kortix workspaces use\`)${C.reset}\n`,
  );
  return { project: ref, bound: true };
}
