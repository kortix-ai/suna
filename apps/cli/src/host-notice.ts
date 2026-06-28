import {
  activeAccount,
  activeHostEntry,
  defaultProject,
  getHost,
  hasEnvTokenHost,
  type Host,
} from './api/config.ts';
import { loadLink } from './project-link.ts';
import { C, pad } from './style.ts';

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
  const notice = resolveHostNotice(hostArg);
  let line = `${C.dim}host ${C.reset}${C.bold}${notice.name}${C.reset}${C.dim} (${notice.url}, ${notice.authState})${C.reset}`;
  // Append account + project for the active host only. With an explicit
  // `--host`, the active-config account/project may belong to a different
  // host, so we don't claim them.
  if (!hostArg) {
    const acct = activeAccountLabel();
    if (acct) line += `${C.dim} · account ${C.reset}${acct}`;
    const proj = activeProjectLabel();
    if (proj) line += `${C.dim} · project ${C.reset}${proj.label}${C.dim} (${proj.source})${C.reset}`;
  }
  return `${line}\n`;
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
 * A compact context block for the bare-`kortix` landing screen: which
 * host / account / project every command will act on. All local reads
 * (config + cwd link) — no network, no latency.
 */
export function renderContext(): string {
  const { name, host } = activeHostEntry();
  const authState = hostAuthState(host, hasEnvTokenHost() ? 'env' : 'stored');
  const acct = activeAccount();
  const proj = activeProjectLabel();
  const labelW = 7; // "account".length
  const rows: string[] = [];
  rows.push(
    `  ${C.dim}${pad('host', labelW)}${C.reset}  ${C.bold}${name}${C.reset}  ${C.faded}(${host.url}, ${authState})${C.reset}`,
  );
  rows.push(
    `  ${C.dim}${pad('account', labelW)}${C.reset}  ${
      acct
        ? acct.name
          ? `${C.bold}${acct.name}${C.reset}  ${C.faded}(${acct.slug})${C.reset}`
          : `${C.bold}${acct.slug}${C.reset}`
        : `${C.faded}— none (run \`kortix accounts use\`)${C.reset}`
    }`,
  );
  rows.push(
    `  ${C.dim}${pad('project', labelW)}${C.reset}  ${
      proj
        ? `${C.bold}${proj.label}${C.reset}  ${C.faded}(${proj.source})${C.reset}`
        : `${C.faded}— none (run \`kortix projects use\`)${C.reset}`
    }`,
  );
  return rows.join('\n') + '\n';
}
