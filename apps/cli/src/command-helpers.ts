import { loadAuth, loadAuthForHost, type Auth } from './api/auth.ts';
import { activeHostName, hasEnvTokenHost, listHosts } from './api/config.ts';
import { ApiError, clientFromAuth, type ApiClient } from './api/client.ts';
import { loadLink, resolveProjectId } from './project-link.ts';
import { ensureDefaultProjectBinding } from './project-bind.ts';
import { C, status } from './style.ts';
import type { MeResponse, ProjectSession, ProjectSummary } from './api/types.ts';

interface ProjectContextOpts {
  /** Override project via --project flag or KORTIX_PROJECT_ID env. */
  projectArg?: string;
  /** Override active host for this invocation via --host flag. */
  hostArg?: string;
}

/**
 * Common setup for any project-scoped command: validate auth, resolve a
 * project id, build an API client. Prints a friendly error and returns
 * null if either piece is missing.
 *
 * Host resolution order:
 *   1. --host flag (per-invocation override)
 *   2. KORTIX_CLI_TOKEN / KORTIX_EXECUTOR_TOKEN (platform-injected sandbox
 *      auth — resolved through `loadAuth()`; a committed link host has no
 *      credentials inside a sandbox, so the env token must win)
 *   3. .kortix/link.json's `host` field (per-repo binding)
 *   4. globally active host (~/.config/kortix/config.json)
 *
 * Backward-compatible call shape: callers that pass a string get the
 * `(projectArg)` behavior; callers that need --host pass an object.
 */
export async function resolveProjectContext(
  optsOrProjectArg?: ProjectContextOpts | string,
): Promise<{ client: ApiClient; projectId: string; auth: Auth } | null> {
  const opts: ProjectContextOpts =
    typeof optsOrProjectArg === 'string'
      ? { projectArg: optsOrProjectArg }
      : optsOrProjectArg ?? {};

  // Resolve the host: explicit flag → sandbox env token → link.json's host → active.
  let hostFromLink: string | undefined;
  if (!opts.hostArg && !hasEnvTokenHost()) {
    hostFromLink = loadLink()?.host ?? undefined;
  }
  const hostName = opts.hostArg ?? hostFromLink;

  const auth = hostName ? loadAuthForHost(hostName) : loadAuth();
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
  let projectId = resolveProjectId(opts.projectArg);
  if (!projectId) {
    // The always-bound invariant: recover by binding a default project right
    // here instead of dead-ending. (Inside a sandbox the env-token host
    // always carries KORTIX_PROJECT_ID, so this never fires there; on a
    // non-TTY it degrades to a hint and the error below.)
    const outcome = await ensureDefaultProjectBinding(auth, {
      promptTitle: 'No project bound — pick one for this command',
    });
    projectId = outcome.project?.project_id ?? null;
  }
  if (!projectId) {
    process.stderr.write(
      `${status.err('No project linked.')} Run \`kortix projects use\`, ` +
        `\`kortix projects link\`, or pass ${C.cyan}--project <id>${C.reset}.\n`,
    );
    return null;
  }
  return { client: clientFromAuth(auth), projectId, auth };
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

export interface LocatedSession {
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

  const ctx = await resolveProjectContext(opts);
  if (ctx) {
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
    process.stderr.write(`${status.err(`Session ${sessionId} not found in any project you can access.`)}\n`);
    if (!opts.hostArg) printHostRetryHints(retryCommand);
    return null;
  }
  return { located: found, switched: true };
}

export interface LocatedProject {
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
      return { located: { client: clientFromAuth(primaryAuth), auth: primaryAuth, project: probed }, switched: false };
    }
    if (probed instanceof ApiError) {
      surfaceApiError(probed);
      return null;
    }
    if (pinned) {
      process.stderr.write(`${status.err(`Project ${projectId} not found on host "${opts.hostArg}".`)}\n`);
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

  process.stderr.write(`${status.err(`Project ${projectId} not found on any host you're logged into.`)}\n`);
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
    process.stderr.write(`    ${C.cyan}kortix login --host ${name} && ${retryCommand(name)}${C.reset}\n`);
  }
}

/** result = the fetched row, false = 404 (keep looking), ApiError = a real failure. */
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
async function scanHostForSession(hostName: string, sessionId: string): Promise<LocatedSession | null> {
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
    const hit = await probeConcurrently(projects, (p) => probeSession(client, p.project_id, sessionId));
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

/** Print an HTTP error in a consistent style + return exit code 1. */
export function surfaceApiError(err: unknown): number {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(
        `${status.err('Token rejected. Run `kortix login` to re-authenticate.')}\n`,
      );
    } else if (err.status === 403) {
      process.stderr.write(
        `${status.err('Forbidden — you may not have permission on this project.')}\n`,
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

export function takeFlagBool(argv: string[], names: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (names.includes(argv[i])) {
      argv.splice(i, 1);
      return true;
    }
  }
  return false;
}
