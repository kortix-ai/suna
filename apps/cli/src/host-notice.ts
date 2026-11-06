import {
  activeHostEntry,
  defaultProject,
  getHost,
  hasEnvTokenHost,
  type Host,
} from './api/config.ts';
import { cachedTokenIdentity } from './api/token-identity.ts';
import { resolveProjectAuth } from './command-helpers.ts';
import { envWorkspaceId, loadLink } from './project-link.ts';
import { C, pad, visibleWidth } from './style.ts';

export interface HostNotice {
  name: string;
  url: string;
  authState: string;
  /** Agent the acting token was minted for, when already known locally. */
  agent?: string;
}

function hostAuthState(host: Host, mode: 'env' | 'stored'): string {
  if (!host.token) return 'not logged in';
  if (mode === 'env') {
    return process.env.KORTIX_SESSION_ID
      ? 'authenticated (session token)'
      : 'authenticated (workspace token)';
  }
  if (host.user_email || host.user_id) return `${host.user_email || host.user_id} (user)`;
  return 'authenticated';
}

/**
 * The agent a token was minted for, from cache only — the host line is a
 * zero-network render and stays one. The cache is filled by any `/accounts/me`
 * the CLI already makes (see api/client.ts), and by the denial footer.
 * Undefined simply means "not known yet", never "no agent".
 */
function tokenAgent(host: Host): string | undefined {
  if (!host.token) return undefined;
  return cachedTokenIdentity(host.token)?.agent ?? undefined;
}

export function findHostArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') return argv[i + 1];
    if (arg.startsWith('--host=')) return arg.slice('--host='.length);
  }
  return undefined;
}

/**
 * The workspace `--workspace` / `--project` names on the command line, so the
 * notice names the workspace the command acts on. A value with a role suffix
 * (`<id>:<role>`, the older `members invite` grant spelling) selects nothing.
 */
export function findWorkspaceArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = /^--(?:workspace|project)=(.*)$/.exec(arg);
    const value = eq ? eq[1] : arg === '--workspace' || arg === '--project' ? argv[i + 1] : undefined;
    if (value && !value.startsWith('-') && !value.includes(':')) return value;
  }
  return undefined;
}

export function resolveHostNotice(hostArg?: string): HostNotice {
  if (hostArg) {
    const host = getHost(hostArg);
    return {
      name: hostArg,
      url: host?.url ?? 'unconfigured',
      authState: host ? hostAuthState(host, 'stored') : 'not logged in',
      ...(host ? { agent: tokenAgent(host) } : {}),
    };
  }

  const { name, host, envWins } = activeHostEntry();
  return {
    name,
    url: host.url,
    // The auth state follows the actual winner: an in-sandbox `hosts use`
    // (KRTX-1705) serves commands from the stored credential, so the notice
    // must stop calling it a session/project token.
    authState: hostAuthState(host, envWins ? 'env' : 'stored'),
    ...(tokenAgent(host) ? { agent: tokenAgent(host) } : {}),
  };
}

export function renderHostNotice(commandArgv: readonly string[]): string | null {
  const command = commandArgv[0];
  if (!command || ['help', '--help', '-h', 'version'].includes(command)) return null;
  const hostArg = findHostArg(commandArgv.slice(1));
  // Host resolution mirrors resolveProjectContext (resolveProjectAuth):
  // --host wins, then the cwd link's stored credentials, then the
  // platform-injected env token. Reading the LINK host while it has no
  // stored credentials resolves a named host that carries nothing — which
  // reported a fully-authenticated agent CLI as "not logged in" on every
  // command (the exact trap called out in api/config.ts) — so the notice
  // falls back to the env host exactly when the command's auth does.
  const notice = resolveHostNotice(resolveProjectAuth({ hostArg }).hostName);
  let line = `${C.dim}host ${C.reset}${C.bold}${notice.name}${C.reset}${C.dim} (${notice.url}, ${notice.authState})${C.reset}`;
  // The token's own identity: WHICH agent this session's minted token belongs
  // to. Printed next to the host because it is a property of the credential,
  // not of the account/project it happens to address.
  if (notice.agent) line += `${C.dim} · agent ${C.reset}${notice.agent}`;
  // Append the workspace for the active host only. With an explicit
  // `--host`, the active-config workspace may belong to a different host, so
  // we don't claim it.
  if (!hostArg) {
    const flagged = findWorkspaceArg(commandArgv.slice(1));
    const proj = flagged ? { label: idPrefix(flagged), source: 'flag' as const } : activeProjectLabel();
    if (proj) line += `${C.dim} · workspace ${C.reset}${proj.label}${C.dim} (${proj.source})${C.reset}`;
    // Session is the leaf: shown only when we're actually inside one (a
    // sandbox run injects KORTIX_SESSION_ID), never as a persisted pointer.
    const session = activeSessionLabel();
    if (session) line += `${C.dim} · session ${C.reset}${session}`;
  }
  return `${line}\n`;
}

/** The ephemeral leaf of the hierarchy. There's no persisted "active
 *  session" — one only exists when the platform injects KORTIX_SESSION_ID
 *  (inside a running sandbox). */
function activeSessionLabel(): string | null {
  const sid = process.env.KORTIX_SESSION_ID;
  return sid ? idPrefix(sid) : null;
}

/** Active project: the cwd's directory link wins over the global default. */
function activeProjectLabel(): { label: string; source: 'linked' | 'default' | 'session' } | null {
  const link = loadLink();
  if (link?.project_id) {
    return { label: idPrefix(link.project_id), source: 'linked' };
  }
  // A session box without the repository has no link file; its project is injected.
  const envProjectId = envWorkspaceId();
  if (envProjectId) return { label: idPrefix(envProjectId), source: 'session' };
  const def = defaultProject();
  if (def) return { label: def.name || idPrefix(def.project_id), source: 'default' };
  return null;
}

/** The first 8 characters of an id. Not the dash-split `shortId`: ids here can be non-UUIDs. */
function idPrefix(id: string): string {
  return id.slice(0, 8);
}

/**
 * The bare-`kortix` landing breadcrumb: a top-down render of WHERE YOU ARE
 * in the Host → Workspace → Session hierarchy, marking auth state
 * and making each gap actionable (a "→ kortix … " next step). All local
 * reads (config + cwd link + env) — no network, no latency.
 *
 * This is the single shared builder for the hierarchy render; commands
 * never hand-roll their own header (the per-command one-liner
 * `renderHostNotice` reads the same resolvers). Layout:
 *
 *   ● host        cloud  (https://api.kortix.com, signed in as …)   ▸ kortix hosts use
 *     workspace   veyris  (linked)
 *     session     —                              open one: kortix chat · kortix sessions new
 *
 * Signed OUT of the active host, the lower levels are hidden (you can't
 * have a workspace without a host) and the host row points at `hosts login`.
 */
export function renderContext(): string {
  // A cwd directory link can pin the host for this directory, overriding the
  // globally-active host. Same precedence as renderHostNotice / resolveProjectContext
  // (resolveProjectAuth): the cwd link's stored credentials, then the
  // platform-injected env token (a named link host has none in a sandbox),
  // then the globally-active host. The link pins the row when its host is
  // what commands will use — including an unauthenticated one, which still
  // names the actionable row ("kortix hosts login").
  const { hostName: linkHostName, auth: linkAuth } = resolveProjectAuth();
  const linkedHost =
    linkHostName && (linkAuth?.token || !hasEnvTokenHost()) ? getHost(linkHostName) : null;
  const { name: activeName, host: activeHost, envWins } = activeHostEntry();
  const name = linkedHost && linkHostName ? linkHostName : activeName;
  const host = linkedHost ?? activeHost;
  const signedIn = Boolean(host.token);
  const authState = hostAuthState(
    host,
    linkedHost ? 'stored' : envWins ? 'env' : 'stored',
  );
  const agent = tokenAgent(host);
  const labelW = 9; // "workspace".length

  const rows: ContextRow[] = [];

  // 1. Host — auth lives here.
  rows.push({
    glyph: signedIn ? `${C.green}●${C.reset}` : `${C.faded}○${C.reset}`,
    label: 'host',
    value: `${C.bold}${name}${C.reset}  ${C.faded}(${host.url}, ${authState})${C.reset}`,
    hint: signedIn ? navHint('kortix hosts use') : gapHint('kortix hosts login'),
  });

  // 1b. Agent — WHO the acting token is, when it was minted for one. Rendered
  // only for an agent token, so a human login keeps the four-level hierarchy.
  if (signedIn && agent) {
    rows.push({
      glyph: ' ',
      label: 'agent',
      value: `${C.bold}${agent}${C.reset}  ${C.faded}(token)${C.reset}`,
      hint: `${C.faded}grants: ${C.reset}${C.cyan}kortix whoami --token-only${C.reset}`,
    });
  }

  // You can't have a workspace or a session without a signed-in host.
  if (!signedIn) return renderRows(rows, labelW);

  // 2. Workspace — one workspace is one project and the account that owns it
  // (the Workspaces model), so the hierarchy is host › workspace › session and
  // the account has no row of its own.
  const proj = activeProjectLabel();
  rows.push(
    proj
      ? {
          glyph: ' ',
          label: 'workspace',
          value: `${C.bold}${proj.label}${C.reset}  ${C.faded}(${proj.source})${C.reset}`,
          // A linked cwd wins and can't be swapped with `workspaces use`, so
          // only point at the switch verb for a global default.
          hint:
            proj.source === 'default'
              ? `${C.faded}switch with \`kortix workspaces use\`${C.reset}`
              : undefined,
        }
      : {
          glyph: `${C.yellow}⚠${C.reset}`,
          label: 'workspace',
          value: `${C.faded}— none${C.reset}`,
          hint: gapHint('kortix workspaces use'),
        },
  );

  // 3. Session — the ephemeral leaf; addressed by id, no persisted pointer.
  const session = activeSessionLabel();
  rows.push({
    glyph: ' ',
    label: 'session',
    value: session ? `${C.bold}${session}${C.reset}` : `${C.faded}—${C.reset}`,
    hint: session
      ? undefined
      : `${C.dim}open one: ${C.reset}${C.cyan}kortix chat${C.reset}${C.dim} · ${C.reset}${C.cyan}kortix sessions new${C.reset}`,
  });

  return renderRows(rows, labelW);
}

interface ContextRow {
  glyph: string;
  label: string;
  value: string;
  hint?: string;
}

/** Navigational hint (a `use`-verb that moves the active pointer). */
function navHint(cmd: string): string {
  return `${C.dim}▸ ${C.reset}${C.cyan}${cmd}${C.reset}`;
}

/** Actionable gap hint (a next step to fill an empty level). */
function gapHint(cmd: string): string {
  return `${C.dim}→ ${C.reset}${C.cyan}${cmd}${C.reset}`;
}

/** Render the hierarchy rows with the value column aligned so the hints
 *  line up in a trailing column. */
function renderRows(rows: ContextRow[], labelW: number): string {
  const valueW = Math.max(...rows.map((r) => visibleWidth(r.value)));
  const lines = rows.map((r) => {
    const left = `  ${r.glyph} ${C.dim}${pad(r.label, labelW)}${C.reset}  ${pad(r.value, valueW)}`;
    return r.hint ? `${left}   ${r.hint}` : left;
  });
  return lines.join('\n') + '\n';
}
