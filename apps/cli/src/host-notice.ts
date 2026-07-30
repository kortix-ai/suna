import {
  activeAccount,
  activeHostEntry,
  defaultProject,
  getHost,
  hasEnvTokenHost,
  type Host,
} from './api/config.ts';
import { loadLink } from './project-link.ts';
import { C, pad, visibleWidth } from './style.ts';

export interface HostNotice {
  name: string;
  url: string;
  authState: string;
}

function hostAuthState(host: Host, mode: 'env' | 'stored'): string {
  if (!host.token) return 'not logged in';
  if (mode === 'env') {
    return process.env.KORTIX_SESSION_ID
      ? 'authenticated (session token)'
      : 'authenticated (project token)';
  }
  if (host.user_email || host.user_id) return `${host.user_email || host.user_id} (user)`;
  return 'authenticated';
}

export function findHostArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') return argv[i + 1];
    if (arg.startsWith('--host=')) return arg.slice('--host='.length);
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
    };
  }

  const { name, host } = activeHostEntry();
  return {
    name,
    url: host.url,
    authState: hostAuthState(host, hasEnvTokenHost() ? 'env' : 'stored'),
  };
}

export function renderHostNotice(commandArgv: readonly string[]): string | null {
  const command = commandArgv[0];
  if (!command || ['help', '--help', '-h', 'version'].includes(command)) return null;
  const hostArg = findHostArg(commandArgv.slice(1));
  const directoryLink = loadLink();
  const linkedHost = !hostArg ? directoryLink?.host : undefined;
  const notice = resolveHostNotice(hostArg ?? linkedHost);
  let line = `${C.dim}host ${C.reset}${C.bold}${notice.name}${C.reset}${C.dim} (${notice.url}, ${notice.authState})${C.reset}`;
  // Append account + project for the active host only. With an explicit
  // `--host`, the active-config account/project may belong to a different
  // host, so we don't claim them.
  if (!hostArg) {
    const acct = linkedHost
      ? directoryLink?.account_id
        ? shortId(directoryLink.account_id)
        : null
      : activeAccountLabel();
    if (acct) line += `${C.dim} · account ${C.reset}${acct}`;
    const proj = activeProjectLabel();
    if (proj) line += `${C.dim} · project ${C.reset}${proj.label}${C.dim} (${proj.source})${C.reset}`;
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
  return sid ? shortId(sid) : null;
}

/** Active account as a short display string, or null when none/sandbox. */
function activeAccountLabel(): string | null {
  const acct = activeAccount();
  if (!acct) return null;
  return acct.name || acct.slug;
}

/** Active project: the cwd's directory link wins over the global default. */
function activeProjectLabel(): { label: string; source: 'linked' | 'default' } | null {
  const link = loadLink();
  if (link?.project_id) {
    return { label: shortId(link.project_id), source: 'linked' };
  }
  const def = defaultProject();
  if (def) return { label: def.name || shortId(def.project_id), source: 'default' };
  return null;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * The bare-`kortix` landing breadcrumb: a top-down render of WHERE YOU ARE
 * in the Host → Account → Project → Session hierarchy, marking auth state
 * and making each gap actionable (a "→ kortix … " next step). All local
 * reads (config + cwd link + env) — no network, no latency.
 *
 * This is the single shared builder for the hierarchy render; commands
 * never hand-roll their own header (the per-command one-liner
 * `renderHostNotice` reads the same resolvers). Layout:
 *
 *   ● host      cloud  (https://api.kortix.com, signed in as …)   ▸ kortix hosts use
 *     account   Acme Capital  (acme)                              ▸ kortix accounts use
 *     project   veyris  (linked)
 *     session   —                              open one: kortix chat · kortix sessions new
 *
 * Signed OUT of the active host, the lower levels are hidden (you can't
 * have an account without a host) and the host row points at `hosts login`.
 */
export function renderContext(): string {
  // A cwd directory link (`loadLink`) can pin the host — and, with it, the
  // account — for this directory, overriding the globally-active host.
  const directoryLink = loadLink();
  const linkedHost = directoryLink?.host ? getHost(directoryLink.host) : null;
  const active = activeHostEntry();
  const name = linkedHost ? directoryLink!.host! : active.name;
  const host = linkedHost ?? active.host;
  const signedIn = Boolean(host.token);
  const authState = hostAuthState(host, hasEnvTokenHost() ? 'env' : 'stored');
  const labelW = 7; // "account".length / "project".length / "session".length

  const rows: ContextRow[] = [];

  // 1. Host — auth lives here.
  rows.push({
    glyph: signedIn ? `${C.green}●${C.reset}` : `${C.faded}○${C.reset}`,
    label: 'host',
    value: `${C.bold}${name}${C.reset}  ${C.faded}(${host.url}, ${authState})${C.reset}`,
    hint: signedIn ? navHint('kortix hosts use') : gapHint('kortix hosts login'),
  });

  // You can't have an account/project/session without a signed-in host.
  if (!signedIn) return renderRows(rows, labelW);

  // 2. Account — a workspace within the active host. A linked directory pins
  // its account via the cwd link (rendered "(linked)"); otherwise the
  // globally-active account applies.
  const acct = linkedHost ? null : activeAccount();
  rows.push(
    acct
      ? {
          glyph: ' ',
          label: 'account',
          value: acct.name
            ? `${C.bold}${acct.name}${C.reset}  ${C.faded}(${acct.slug})${C.reset}`
            : `${C.bold}${acct.slug}${C.reset}`,
          hint: navHint('kortix accounts use'),
        }
      : linkedHost && directoryLink?.account_id
        ? {
            glyph: ' ',
            label: 'account',
            value: `${C.bold}${shortId(directoryLink.account_id)}${C.reset}  ${C.faded}(linked)${C.reset}`,
            hint: navHint('kortix accounts use'),
          }
        : {
            glyph: `${C.yellow}⚠${C.reset}`,
            label: 'account',
            value: `${C.faded}— none${C.reset}`,
            hint: gapHint('kortix accounts use'),
          },
  );

  // 3. Project — a project within the active account.
  const proj = activeProjectLabel();
  rows.push(
    proj
      ? {
          glyph: ' ',
          label: 'project',
          value: `${C.bold}${proj.label}${C.reset}  ${C.faded}(${proj.source})${C.reset}`,
          // A linked cwd wins and can't be swapped with `projects use`, so
          // only point at the switch verb for a global default.
          hint:
            proj.source === 'default'
              ? `${C.faded}switch with \`kortix projects use\`${C.reset}`
              : undefined,
        }
      : {
          glyph: `${C.yellow}⚠${C.reset}`,
          label: 'project',
          value: `${C.faded}— none${C.reset}`,
          hint: gapHint('kortix projects use'),
        },
  );

  // 4. Session — the ephemeral leaf; addressed by id, no persisted pointer.
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
