import { FEATURE_DISABLED_CODE } from '@kortix/sdk';

import { type Auth, loadAuth, loadAuthForHost, sameApiBase } from './api/auth.ts';
import { type ApiClient, ApiError, clientFromAuth } from './api/client.ts';
import {
  activeAccount,
  activeHostName,
  envTokenHost,
  getHost,
  hasEnvTokenHost,
  listHosts,
} from './api/config.ts';
import type { MeResponse, ProjectSession, ProjectSummary } from './api/types.ts';
import { ensureDefaultProjectBinding } from './project-bind.ts';
import { loadLink, resolveProjectRef } from './project-link.ts';
import { C, status } from './style.ts';
import { denialDetailFromBody, recordPermissionDenial } from './token-denial.ts';

interface ProjectContextOpts {
  /** Override project via --project flag or KORTIX_PROJECT_ID env. */
  projectArg?: string;
  /** Override active host for this invocation via --host flag. */
  hostArg?: string;
  /**
   * Enforce ONE principal (KRTX-1486, the change-request commands): a
   * project resolved from .kortix/link.json travels with its own host's
   * stored credential — never the sandbox's ambient session token, which is
   * bound to the sandbox's own project. Without stored credentials for that
   * host the command stops with an explicit login pointer instead of a
   * doomed cross-project request. Other commands keep the documented
   * env-token fallback.
   */
  onePrincipal?: boolean;
  /**
   * Do not print "No project linked" when nothing resolves.
   *
   * Set by callers that have a fallback — `locateSessionAnywhere` goes on to
   * scan the host's other accounts, and usually finds the session. Printing a
   * red ✗ first announces a failure that has not happened yet: the command then
   * succeeds, but anyone reading the output (or piping it through `head`)
   * concludes it failed. The fallback prints its own error if it runs dry.
   */
  quietWhenUnresolved?: boolean;
}

/**
 * The auth (and the host name whose credentials serve it) for project-scoped
 * commands: `--host` → the cwd link's host (its stored credentials are what
 * reach a non-session project from inside a sandbox) → the injected env
 * token → the active host. resolveProjectContext and the host notice both
 * read this so the header never names credentials the command will not use.
 */
export function resolveProjectAuth(opts: { hostArg?: string } = {}): {
  hostName?: string;
  auth: Auth | null;
  /** Plain auth resolved to the stored active host (KRTX-1705) while the
   *  injected sandbox delegation points at a different deployment: the env
   *  project/session ids cannot be served by this credential, so the project
   *  must resolve from the host's own context — the branch an explicit
   *  `--host` already uses. */
  hostScoped?: boolean;
} {
  const link = opts.hostArg ? null : loadLink();
  let hostName = opts.hostArg ?? link?.host ?? undefined;
  let auth = hostName ? loadAuthForHost(hostName) : loadAuth();
  // A link naming a host with no stored credentials must not dead-end the CLI
  // inside a sandbox: the injected env token stays the fallback there.
  if (!auth?.token && !opts.hostArg && hasEnvTokenHost()) {
    auth = loadAuth();
    hostName = undefined;
  }
  // Plain commands may now act as the stored active host credential
  // (activeHost() prefers it over the sandbox env token). The env project id
  // belongs to the injected deployment — valid against this credential only
  // when both point at the same deployment. A link-bound host never scopes
  // here: the link binds host and project together, and its credential (or
  // the env fallback) already matches the project it supplies.
  // The ambient deployment is the injected env host's own url — the
  // KORTIX_API_URL override when set, else the default cloud base.
  const ambientBase = envTokenHost()?.url;
  let hostScoped = false;
  if (!opts.hostArg && !hostName && hasEnvTokenHost() && auth?.token) {
    // A partial Auth without an api_base cannot prove the cross-deployment
    // case — keep the env project chain (the pre-KRTX-1705 behavior).
    hostScoped =
      Boolean(auth.api_base) &&
      ambientBase !== undefined &&
      !sameApiBase(auth.api_base, ambientBase);
  }
  return { hostName, auth, hostScoped };
}

/**
 * Common setup for any project-scoped command: validate auth, resolve a
 * project id, build an API client. Prints a friendly error and returns
 * null if either piece is missing.
 *
 * Host resolution order:
 *   1. --host flag (per-invocation override)
 *   2. .kortix/link.json's `host` field (per-directory binding — its stored
 *      credentials are what make a NON-session project reachable from inside
 *      a sandbox, where the injected token is scoped to the session's project)
 *   3. KORTIX_TOKEN (platform-injected sandbox auth — the fallback when the
 *      link names a host with no stored credentials, so the CLI never
 *      dead-ends on "not logged in")
 *   4. globally active host (~/.config/kortix/config.json)
 *
 * Project id resolution order (resolveProjectRef):
 *   1. --project flag
 *   2. .kortix/link.json in cwd (the most specific binding — it outranks the
 *      session env so a linked clone reaches its own project; the host notice
 *      already displays it as "linked", so behavior must match)
 *   3. KORTIX_PROJECT_ID env (platform-injected inside a sandbox)
 *   4. the active host's global default project (`kortix projects use`)
 *
 * ONE PRINCIPAL (KRTX-1486): whichever source resolves the project also
 * supplies the credential. The env token is the credential only for the env
 * project; a project that came from the config side (link.json or the active
 * host's default) is paired with THAT host's stored credential, or the
 * command stops with an explicit `kortix login --host` pointer; see the guard
 * below.
 *
 * Backward-compatible call shape: callers that pass a string get the
 * `(projectArg)` behavior; callers that need --host pass an object.
 */
export type CtxOpts = Pick<ProjectContextOpts, 'projectArg' | 'hostArg' | 'onePrincipal'>;

export async function resolveProjectContext(
  optsOrProjectArg?: ProjectContextOpts | string,
): Promise<{ client: ApiClient; projectId: string; auth: Auth } | null> {
  const opts: ProjectContextOpts =
    typeof optsOrProjectArg === 'string'
      ? { projectArg: optsOrProjectArg }
      : (optsOrProjectArg ?? {});

  const {
    hostName,
    auth: resolvedAuth,
    hostScoped,
  } = resolveProjectAuth({ hostArg: opts.hostArg });
  let auth: Auth | null = resolvedAuth;
  if (!auth?.token) {
    if (hostName) {
      const source = opts.hostArg ? '(--host)' : '(from .kortix/link.json)';
      process.stderr.write(
        `${status.err(`Host "${hostName}" ${source} is not logged in.`)} Run ` +
          `${C.cyan}kortix login --host ${hostName}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    }
    return null;
  }
  // An explicit --host names a different deployment: every ambient project id
  // (KORTIX_PROJECT_ID, a link bound to another host, the active host's
  // default) lives on the caller's own host and only 404s against the named
  // host's token. Resolve the project from the named host's own context — a
  // --project pin, a link bound to that same host, or that host's stored
  // default — and say so clearly when it has none.
  //
  // The same scoping applies without the flag when the plain-command auth
  // resolved to the stored active host while the sandbox delegation points
  // elsewhere (hostScoped above): pairing the host credential with the env
  // project id would 404 cross-deployment, exactly like --host would.
  const scopedHost = opts.hostArg ?? (hostScoped ? (activeHostName() ?? undefined) : undefined);
  let projectId: string | null;
  if (scopedHost && !opts.projectArg) {
    const link = loadLink();
    const linkProject = link?.host === scopedHost ? link.project_id : undefined;
    const hostDefault = getHost(scopedHost)?.default_project;
    projectId = linkProject ?? hostDefault?.project_id ?? null;
    if (!projectId) {
      if (!opts.quietWhenUnresolved) {
        const source = opts.hostArg ? '(--host)' : '(the active host)';
        process.stderr.write(
          `${status.err(`No project context on host "${scopedHost}" ${source}.`)} Pass ` +
            `${C.cyan}--project <id>${C.reset} (${C.cyan}kortix projects ls${opts.hostArg ? ` --host ${opts.hostArg}` : ''}${C.reset} lists them).\n`,
        );
      }
      return null;
    }
  } else {
    const ref = resolveProjectRef(opts.projectArg);
    projectId = ref?.projectId ?? null;
    // ONE PRINCIPAL (KRTX-1486): the ambient sandbox session token is bound
    // to the sandbox's own project. A project the CLI config resolved
    // (.kortix/link.json) must never pair with it — writes 403 cross-project
    // and reads return the wrong project's rows. The link project travels
    // with its own host's stored credential; without stored credentials for
    // that host, stop with an explicit login pointer instead of a doomed
    // request. (`--host <name>` cannot rescue that state: it resolves the
    // same absent credentials, so logging in is the only working fix.)
    if (projectId && opts.onePrincipal && hasEnvTokenHost() && ref?.source === 'link') {
      const configHostName = loadLink()?.host ?? activeHostName() ?? undefined;
      const configAuth = configHostName ? loadAuthForHost(configHostName) : null;
      if (configAuth?.token) {
        auth = configAuth;
      } else {
        const hostLabel = configHostName
          ? `host "${configHostName}"`
          : 'a host with no stored credentials';
        process.stderr.write(
          `${status.err(
            `Project is bound to ${hostLabel} (.kortix/link.json) but only the ambient sandbox session token is available here — it cannot act on that project.`,
          )} Run ${C.cyan}kortix login --host ${configHostName ?? '<host>'}${C.reset} first.\n`,
        );
        return null;
      }
    }
    if (!projectId) {
      // The always-bound invariant: recover by binding a default project right
      // here instead of dead-ending. (Inside a sandbox the env-token host
      // always carries KORTIX_PROJECT_ID, so this never fires there; on a
      // non-TTY it degrades to a hint and the error below.)
      const outcome = await ensureDefaultProjectBinding(auth, {
        promptTitle: 'No project bound — pick one for this command',
        quiet: opts.quietWhenUnresolved,
      });
      projectId = outcome.project?.project_id ?? null;
    }
  }
  if (!projectId) {
    if (!opts.quietWhenUnresolved) {
      process.stderr.write(
        `${status.err('No project linked.')} Run \`kortix projects use\`, ` +
          `\`kortix projects link\`, or pass ${C.cyan}--project <id>${C.reset}.\n`,
      );
    }
    return null;
  }
  return { client: clientFromAuth(auth), projectId, auth };
}

export interface AccountContext {
  client: ApiClient;
  accountId: string;
  auth: Auth;
}

/**
 * Common setup for any ACCOUNT-scoped command (`/accounts/:id/...`): validate
 * auth, resolve the account id, build a client already scoped to it.
 *
 * The canonical RBAC surface is account-scoped — `role_assignments`, the role
 * catalog and the permission catalog all hang off `/accounts/:accountId/iam`,
 * even for a grant that lands on ONE project. So `kortix access`, `kortix roles`
 * and `kortix permissions` all need this, not `resolveProjectContext`.
 *
 * Account resolution order: `--account` → the active account → the host's
 * default account from the stored credentials. With `--host`, only that
 * host's stored account is used unless `--account` explicitly overrides it.
 */
export function resolveAccountContext(
  opts: {
    accountArg?: string;
    hostArg?: string;
    /** Commands on person-level routes (connected apps) run with no account. */
    accountOptional?: boolean;
  } = {},
): AccountContext | null {
  const auth = opts.hostArg ? loadAuthForHost(opts.hostArg) : loadAuth();
  if (!auth?.token) {
    if (opts.hostArg) {
      process.stderr.write(
        `${status.err(`Host "${opts.hostArg}" (--host) is not logged in.`)} Run ` +
          `${C.cyan}kortix login --host ${opts.hostArg}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    }
    return null;
  }
  const accountId =
    opts.accountArg ||
    (opts.hostArg ? auth.account_id : activeAccount()?.id || auth.account_id) ||
    '';
  if (!accountId && !opts.accountOptional) {
    process.stderr.write(
      `${status.err('No active account. Run `kortix accounts use` or pass --account <id>.')}\n`,
    );
    return null;
  }
  return { client: clientFromAuth(auth, { accountId }), accountId, auth };
}

/**
 * Emit a value as pretty JSON to stdout — the machine-readable output mode
 * for read commands (`--json`). Agents parse this instead of scraping the
 * human-formatted tables. Keep it dumb: print what the command already has
 * (ideally the raw API payload) so the JSON shape tracks the REST API.
 */
export function emitJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** Render `params` as a `?a=b&c=d` query string, skipping undefined and empty values. */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

// ── Cross-host/account/project resource discovery ───────────────────────────
//
// Every session/project route is scoped to a specific Kortix host (a project
// id or session id only exists in one Postgres) — so an id from a different
// host, or a different account on the same host, than the one currently
// active/linked 404s even though it's real and reachable with the same (or a
// differently-logged-in) set of credentials. `locateSessionAnywhere` and
// `locateProjectAnywhere` try the normal fast path first, then — unless the
// caller pinned --host/--project — scan every OTHER logged-in host (and, for
// sessions, every account on it) for the id. If it's on a host with no stored
// credentials at all, we can't silently authenticate (login is an interactive
// browser flow) — so the failure message prints ready-to-run
// `login && retry --host <name>` one-liners for those hosts instead.

interface LocatedSession {
  client: ApiClient;
  auth: Auth;
  projectId: string;
  projectName?: string;
  session: ProjectSession;
  /** Only set when the session was found via the cross-host scan. */
  hostName?: string;
}

/**
 * Resolve which project (and host) a session id lives in, and return the
 * already-fetched session row (no redundant re-fetch by the caller). Tries
 * the caller's normally-resolved context (--host/--project, link, or
 * default) first. `--project` pins the exact target — no further search.
 * `--host` alone only pins the HOST — the id may still be in a different
 * account/project on it, so that host's other accounts/projects are
 * scanned too before giving up and moving on. With neither flag, every
 * other logged-in host is scanned as well. `retryCommand` builds the full
 * CLI invocation to suggest for a host without stored credentials (e.g.
 * `(host) => \`kortix sessions connect ${id} --host ${host}\``). Prints its
 * own progress/error messages; returns null on failure.
 */
export async function locateSessionAnywhere(
  sessionId: string,
  opts: ProjectContextOpts,
  retryCommand: (hostName: string) => string,
): Promise<{ located: LocatedSession; switched: boolean } | null> {
  const projectPinned = Boolean(opts.projectArg);
  // A pinned host with literally no stored credentials can't be scanned
  // either — resolveProjectContext already explained that below.
  const hostPinnedButLoggedOut = Boolean(opts.hostArg) && !loadAuthForHost(opts.hostArg!)?.token;

  // Quiet: the cross-account scan below is the real answer for a user whose
  // active account holds no projects, and it usually finds the session.
  const ctx = await resolveProjectContext({ ...opts, quietWhenUnresolved: true });
  if (ctx) {
    // Short-id ergonomics: `sessions ls`/`status` print 8-char ids, so accept
    // any unambiguous prefix instead of failing with "Invalid session id". The
    // list already carries the full row, so a prefix hit returns it directly and
    // skips the per-session re-fetch below.
    if (!SESSION_UUID_RE.test(sessionId)) {
      const expanded = await expandSessionIdPrefix(ctx.client, ctx.projectId, sessionId);
      if (expanded === 'ambiguous') {
        process.stderr.write(
          `${status.err(`Several sessions match "${sessionId}" — use more of the id.`)}\n`,
        );
        return null;
      }
      if (expanded) {
        return {
          located: {
            client: ctx.client,
            auth: ctx.auth,
            projectId: ctx.projectId,
            session: expanded,
          },
          switched: false,
        };
      }
    }
    const probed = await probeSession(ctx.client, ctx.projectId, sessionId);
    if (probed !== false && !(probed instanceof ApiError)) {
      return {
        located: { client: ctx.client, auth: ctx.auth, projectId: ctx.projectId, session: probed },
        switched: false,
      };
    }
    if (probed instanceof ApiError) {
      surfaceApiError(probed);
      return null;
    }
  } else if (projectPinned || hostPinnedButLoggedOut) {
    // resolveProjectContext already printed why (bad --host/--project, or
    // not logged in on that host).
    return null;
  }

  if (projectPinned) {
    process.stderr.write(`${status.err(`Session ${sessionId} not found in this project.`)}\n`);
    return null;
  }

  process.stderr.write(
    `${C.dim}Not in the active project — checking ` +
      `${opts.hostArg ? `other accounts on "${opts.hostArg}"` : 'your other logged-in hosts'}…${C.reset}\n`,
  );
  const found = opts.hostArg
    ? await scanHostForSession(opts.hostArg, sessionId)
    : await scanAllHostsForSession(sessionId);
  if (!found) {
    process.stderr.write(
      `${status.err(`Session ${sessionId} not found in any project you can access.`)}\n`,
    );
    if (!opts.hostArg) printHostRetryHints(retryCommand);
    return null;
  }
  return { located: found, switched: true };
}

interface LocatedProject {
  client: ApiClient;
  auth: Auth;
  project: ProjectSummary;
  /** Only set when the project was found via the cross-host scan. */
  hostName?: string;
}

/**
 * Resolve which host a project id lives on, and return the already-fetched
 * project row. Project-id routes resolve their account from the id itself
 * (see `ClientFromAuthOptions.accountId` in api/client.ts), so unlike
 * sessions this only needs to scan hosts, not accounts within a host.
 */
export async function locateProjectAnywhere(
  projectId: string,
  opts: { hostArg?: string },
  retryCommand: (hostName: string) => string,
): Promise<{ located: LocatedProject; switched: boolean } | null> {
  const pinned = Boolean(opts.hostArg);
  const primaryHostName = opts.hostArg ?? activeHostName() ?? undefined;
  const primaryAuth = opts.hostArg ? loadAuthForHost(opts.hostArg) : loadAuth();

  if (!primaryAuth?.token && pinned) {
    process.stderr.write(
      `${status.err(`Host "${opts.hostArg}" is not logged in.`)} Run ${C.cyan}kortix login --host ${opts.hostArg}${C.reset}.\n`,
    );
    return null;
  }
  if (primaryAuth?.token) {
    const probed = await probeProject(clientFromAuth(primaryAuth), projectId);
    if (probed !== false && !(probed instanceof ApiError)) {
      return {
        located: { client: clientFromAuth(primaryAuth), auth: primaryAuth, project: probed },
        switched: false,
      };
    }
    if (probed instanceof ApiError) {
      surfaceApiError(probed);
      return null;
    }
    if (pinned) {
      process.stderr.write(
        `${status.err(`Project ${projectId} not found on host "${opts.hostArg}".`)}\n`,
      );
      return null;
    }
  }

  process.stderr.write(
    `${C.dim}Not on the active host — checking your other logged-in hosts…${C.reset}\n`,
  );
  const others = listHosts().filter((h) => h.host.token && h.name !== primaryHostName);
  const hit = await probeConcurrently(others, async (h) => {
    const auth = loadAuthForHost(h.name);
    if (!auth) return false as const;
    return probeProject(clientFromAuth(auth), projectId);
  });
  if (hit) {
    const auth = loadAuthForHost(hit.item.name)!;
    return {
      located: { client: clientFromAuth(auth), auth, project: hit.result, hostName: hit.item.name },
      switched: true,
    };
  }

  process.stderr.write(
    `${status.err(`Project ${projectId} not found on any host you're logged into.`)}\n`,
  );
  printHostRetryHints(retryCommand);
  return null;
}

/** Print copy-pasteable `login && retry --host <name>` lines for every known
 *  host (built-in or custom) that has no stored credentials yet — the id may
 *  live there, but we can't silently authenticate (login is an interactive
 *  browser flow). No-op when every known host already has a token. */
function printHostRetryHints(retryCommand: (hostName: string) => string): void {
  const names = listHosts()
    .filter((h) => !h.host.token)
    .map((h) => h.name);
  if (names.length === 0) return;
  process.stderr.write(
    `  ${C.dim}Not logged in on those hosts yet. If it lives on one of them:${C.reset}\n`,
  );
  for (const name of names) {
    process.stderr.write(
      `    ${C.cyan}kortix login --host ${name} && ${retryCommand(name)}${C.reset}\n`,
    );
  }
}

/** result = the fetched row, false = 404 (keep looking), ApiError = a real failure. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Expand a short session-id prefix against the project's session list,
 *  returning the matched row (the list already carries it — no re-fetch). */
export async function expandSessionIdPrefix(
  client: ApiClient,
  projectId: string,
  reference: string,
): Promise<ProjectSession | 'ambiguous' | null> {
  try {
    const sessions = await client.get<ProjectSession[]>(`/projects/${projectId}/sessions`);
    const matches = sessions.filter((s) => s.session_id.startsWith(reference));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return 'ambiguous';
    return null;
  } catch {
    // Listing failed — let the direct probe surface the real error.
    return null;
  }
}

async function probeSession(
  client: ApiClient,
  projectId: string,
  sessionId: string,
): Promise<ProjectSession | false | ApiError> {
  try {
    return await client.get<ProjectSession>(`/projects/${projectId}/sessions/${sessionId}`);
  } catch (err) {
    if (err instanceof ApiError) return err.status === 404 ? false : err;
    return false; // network hiccup on one project shouldn't kill the whole scan
  }
}

async function probeProject(
  client: ApiClient,
  projectId: string,
): Promise<ProjectSummary | false | ApiError> {
  try {
    return await client.get<ProjectSummary>(`/projects/${projectId}`);
  } catch (err) {
    if (err instanceof ApiError) return err.status === 404 ? false : err;
    return false;
  }
}

/** Scan every logged-in host's accounts and projects for a session id,
 *  active host first (most likely spot); each host's accounts/projects are
 *  probed with bounded concurrency. */
async function scanAllHostsForSession(sessionId: string): Promise<LocatedSession | null> {
  const hosts = [...listHosts()]
    .filter((h) => h.host.token)
    .sort((a, b) => Number(b.active) - Number(a.active));

  for (const { name } of hosts) {
    const found = await scanHostForSession(name, sessionId);
    if (found) return found;
  }
  return null;
}

/** Scan every account on ONE named (already logged-in) host for a session
 *  id, concurrency-capped within each account's project list. */
async function scanHostForSession(
  hostName: string,
  sessionId: string,
): Promise<LocatedSession | null> {
  const auth = loadAuthForHost(hostName);
  if (!auth?.token) return null;
  let me: MeResponse;
  try {
    me = await clientFromAuth(auth).get<MeResponse>('/accounts/me');
  } catch {
    return null;
  }
  for (const acct of me.accounts) {
    const client = clientFromAuth(auth, { accountId: acct.account_id });
    let projects: ProjectSummary[];
    try {
      projects = await client.get<ProjectSummary[]>('/projects');
    } catch {
      continue;
    }
    const hit = await probeConcurrently(projects, (p) =>
      probeSession(client, p.project_id, sessionId),
    );
    if (hit) {
      return {
        client,
        auth,
        projectId: hit.item.project_id,
        projectName: hit.item.name,
        session: hit.result,
        hostName,
      };
    }
  }
  return null;
}

/** Probe `items` with bounded concurrency; returns the first item whose
 *  probe resolves to a truthy, non-error result (short-circuits new work,
 *  but in-flight probes at the moment of the hit still finish). */
async function probeConcurrently<Item, Result>(
  items: Item[],
  probe: (item: Item) => Promise<Result | false | ApiError>,
): Promise<{ item: Item; result: Result } | null> {
  const CONCURRENCY = 8;
  let idx = 0;
  let found: { item: Item; result: Result } | null = null;
  const worker = async (): Promise<void> => {
    while (idx < items.length && !found) {
      const i = idx++;
      const r = await probe(items[i]!);
      if (r !== false && !(r instanceof ApiError)) found = { item: items[i]!, result: r };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return found;
}

/**
 * Pull the server's feature-flag gate message off an error, or null when the
 * error is not that gate.
 *
 * The gate is one shape on the wire — 403 `{ error, code: 'feature_disabled',
 * feature }` (apps/api/src/feature-flags/gate.ts) — but reaches the CLI as two
 * error classes: the CLI's own `ApiError` keeps the parsed body in `.body`,
 * while an SDK `ApiError` thrown by a `kortix.*` handle keeps it in
 * `.details`/`.data` and lifts `code` onto the error. Both are read
 * structurally here, and the status is deliberately NOT checked, so a future
 * status carrying the same code still surfaces the same message.
 */
function featureDisabledMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const carrier = err as {
    code?: unknown;
    message?: unknown;
    body?: unknown;
    details?: unknown;
    data?: unknown;
  };
  const body = [carrier.body, carrier.details, carrier.data].find(
    (candidate): candidate is Record<string, unknown> =>
      !!candidate && typeof candidate === 'object' && !Array.isArray(candidate),
  );
  const code = typeof carrier.code === 'string' ? carrier.code : body?.code;
  if (code !== FEATURE_DISABLED_CODE) return null;
  // The server's prose already names the feature and points at
  // Settings → Feature flags — print it verbatim rather than paraphrasing.
  const fromBody = body?.error;
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
  return typeof carrier.message === 'string' && carrier.message.length > 0 ? carrier.message : null;
}

/** The 401 line every rejected-credential surface prints. The server's verdict
 *  (e.g. `project token <id> is revoked`) names the credential the caller
 *  passed; without it every rejection reads the same and the customer cannot
 *  tell WHICH token the API refused (KRTX-1564). */
export function tokenRejectedLine(
  reason?: string | null,
  remedy = 'Run `kortix login` to re-authenticate.',
): string {
  const why = reason ? ` — ${reason}` : '';
  return `Token rejected${why}. ${remedy}`;
}

/** Print an HTTP error in a consistent style + return exit code 1. */
export function surfaceApiError(err: unknown): number {
  // The feature-flag gate is actionable on its own — never let it fall through
  // to the generic 403 "you may not have permission" prose, which sends the
  // user hunting for a role problem that does not exist.
  const featureDisabled = featureDisabledMessage(err);
  if (featureDisabled) {
    process.stderr.write(`${status.err(featureDisabled)}\n`);
    return 1;
  }
  if (err instanceof ApiError) {
    // Both codes are identity verdicts. Note it so the CLI's tail can name the
    // token that was refused (see token-denial.ts) — the message itself only
    // ever names the action.
    recordPermissionDenial(err.status, denialDetailFromBody(err.body), err.credential);
    if (err.status === 401) {
      // The server's reason names the credential ("project token <id> is
      // revoked") when it has one; the bare line otherwise.
      process.stderr.write(`${status.err(tokenRejectedLine(err.message))}\n`);
    } else if (err.status === 403) {
      // Surface the server's specific reason when it has one (e.g. the
      // backend-only secrets 403 tells you to use an API key or PAT);
      // fall back to the generic role message otherwise.
      process.stderr.write(
        `${status.err(err.message || 'Forbidden — you may not have permission on this project.')}\n`,
      );
    } else if (err.status === 404) {
      process.stderr.write(`${status.err(err.message || 'Not found.')}\n`);
    } else {
      process.stderr.write(`${status.err(`HTTP ${err.status}: ${err.message}`)}\n`);
    }
    return 1;
  }
  process.stderr.write(`${status.err((err as Error).message)}\n`);
  return 1;
}

/** Print a usage error + return the arg-error exit code (2). */
export function fail(message: string): number {
  process.stderr.write(`${status.err(message)}\n`);
  return 2;
}

/** A required argument is absent: print "Pass <what>." + return 2. */
export function missing(what: string): number {
  return fail(`Pass ${what}.`);
}

/** The first dash-separated segment of an id — `3f2a…-…` prints as `3f2a…`. */
export function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}

/** Relative span → milliseconds: minutes, hours, days, weeks or years. */
const SPAN_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

const RELATIVE_SPAN = /^(\d+)\s*(m|h|d|w|y)$/i;

/**
 * Resolve a timestamp argument to an ISO instant: a relative span (`24h`,
 * `7d`, `30m`, `2w`, `1y`) resolved `sign` seconds from `now` (audit reads the
 * past with -1, token expiry looks ahead with +1), or an absolute instant
 * passed through normalized. Returns null for anything it cannot parse, so
 * the caller can reject instead of coercing garbage to now.
 */
export function resolveSpanInstant(input: string, now: Date, sign: 1 | -1): string | null {
  const value = input.trim();
  if (!value) return null;
  const relative = RELATIVE_SPAN.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? '').toLowerCase();
    const ms = SPAN_MS[unit];
    if (!Number.isFinite(amount) || amount <= 0 || ms === undefined) return null;
    return new Date(now.getTime() + sign * amount * ms).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Find and pull out a flag value from argv (`--project foo` or
 *  `--project=foo`). Mutates the array — caller passes a sliced copy. */
export function takeFlagValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    for (const n of names) {
      if (a === n) {
        const v = argv[i + 1];
        if (!v || v.startsWith('-')) throw new Error(`${n} requires a value`);
        argv.splice(i, 2);
        return v;
      }
      const eq = `${n}=`;
      if (a.startsWith(eq)) {
        const v = a.slice(eq.length);
        argv.splice(i, 1);
        return v;
      }
    }
  }
  return undefined;
}

/** Collect EVERY occurrence of a repeatable flag (`--secret A --secret B`, or
 *  the `--secret=A` form). Returns [] when absent. Same value rules as
 *  takeFlagValue; mutates argv. */
export function takeFlagValues(argv: string[], names: string[]): string[] {
  const out: string[] = [];
  for (;;) {
    const v = takeFlagValue(argv, names);
    if (v === undefined) break;
    out.push(v);
  }
  return out;
}

export function takeFlagBool(argv: string[], names: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (names.includes(argv[i])) {
      argv.splice(i, 1);
      return true;
    }
  }
  return false;
}
