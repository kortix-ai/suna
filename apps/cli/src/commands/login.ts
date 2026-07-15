import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import {
  DEFAULT_API_BASE,
  authFileLocation,
  loadAuthForHost,
  saveAuthForHost,
} from '../api/auth.ts';
import { startCallbackServer } from '../api/browser-auth.ts';
import { ApiError, createApiClient } from '../api/client.ts';
import {
  DEFAULT_HOST_NAME,
  activeHostName,
  getHost,
  setActiveAccount,
  validateHostName,
} from '../api/config.ts';
import type { MeResponse } from '../api/types.ts';
import { ensureDefaultProjectBinding } from '../project-bind.ts';
import { C, help, status } from '../style.ts';
import { webDashboardUrl } from '../web-url.ts';

const HELP = help`Usage: kortix login [options]

Authenticate the CLI against the Kortix cloud. Browser opens to the
dashboard, one click authorizes this CLI, the token is sent back to a
local callback — no copy/paste.

Options:
  --host <name>     Save under a specific named host (default: active or
                    "${DEFAULT_HOST_NAME}"). Use this to add a second
                    instance: \`kortix login --host local --api …\`.
  --api <url>       API base URL the host points at (default: stored
                    host URL or ${DEFAULT_API_BASE}).
  --token <pat>     Skip the browser flow and authenticate directly
                    with a token. Useful for CI or headless boxes.
  --no-project      Skip the default-project binding step at the end.
  -h, --help        Show this help.

Examples:
  kortix login
  kortix login --host local --api http://localhost:8008
  kortix login --token kortix_pat_...
`;

interface LoginFlags {
  token?: string;
  api?: string;
  host?: string;
  noProject: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): LoginFlags {
  const f: LoginFlags = { help: false, noProject: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') f.help = true;
    else if (a === '--no-project') f.noProject = true;
    else if (a === '--token') {
      const next = argv[i + 1];
      if (!next) throw new Error('--token requires a value');
      f.token = next;
      i += 1;
    } else if (a === '--api') {
      const next = argv[i + 1];
      if (!next) throw new Error('--api requires a value');
      f.api = next;
      i += 1;
    } else if (a === '--host') {
      const next = argv[i + 1];
      if (!next) throw new Error('--host requires a value');
      f.host = next;
      i += 1;
    } else {
      throw new Error(`unknown option "${a}"`);
    }
  }
  return f;
}

export async function runLogin(argv: string[]): Promise<number> {
  let flags: LoginFlags;
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

  // Resolve which host we're logging into.
  const hostName = flags.host ?? activeHostName() ?? DEFAULT_HOST_NAME;
  try {
    validateHostName(hostName);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  // Pick the API base URL with this priority:
  //   --api flag → existing host's URL → KORTIX_API_URL env → default
  const existing = getHost(hostName);
  const apiBase = flags.api ?? existing?.url ?? process.env.KORTIX_API_URL ?? DEFAULT_API_BASE;

  // If this host already has a working token + caller didn't pass
  // --token or --api, treat that as a no-op login.
  if (existing?.token && !flags.token && !flags.api) {
    process.stdout.write(
      `${status.info(`Already logged in to host ${C.bold}${hostName}${C.reset} as ${C.bold}${existing.user_email || existing.user_id}${C.reset}`)}\n`,
    );
    process.stdout.write(
      `${C.dim}  Run \`kortix logout --host ${hostName}\` first to switch accounts.${C.reset}\n`,
    );
    return 0;
  }

  const token = flags.token ?? (await browserLogin(apiBase, existing?.dashboard_url));
  if (!token) return 1;

  if (!token.startsWith('kortix_pat_')) {
    process.stderr.write(
      `${status.err('Invalid API key format — expected `kortix_pat_...` prefix.')}\n`,
    );
    return 1;
  }

  // Verify the token + capture identity for the host record.
  const client = createApiClient({ apiBase, token });
  let me: MeResponse;
  try {
    me = await client.get<MeResponse>('/accounts/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      process.stderr.write(`${status.err('Token rejected by the API. Try again.')}\n`);
    } else {
      process.stderr.write(`${status.err(`Failed to verify token: ${(err as Error).message}`)}\n`);
    }
    return 1;
  }

  const primary = me.accounts[0];
  saveAuthForHost(
    hostName,
    {
      api_base: apiBase,
      token,
      user_id: me.user_id,
      user_email: me.email,
      account_id: primary?.account_id ?? '',
      logged_in_at: new Date().toISOString(),
    },
    /* makeActive */ true,
  );
  // Persist the active account's display fields (and reconcile any default
  // project) so the context block + `accounts ls` read correctly offline.
  if (primary) {
    setActiveAccount({ id: primary.account_id, slug: primary.slug, name: primary.name }, hostName);
  }

  process.stdout.write(
    `\n${status.ok(`Logged in to host ${C.bold}${hostName}${C.reset} as ${C.bold}${me.email || me.user_id}${C.reset}`)}\n`,
  );
  if (primary) {
    process.stdout.write(
      `${C.dim}  Active account: ${C.reset}${primary.name} ${C.faded}(${primary.slug})${C.reset}\n`,
    );
  }
  process.stdout.write(`${C.dim}  Stored at ${authFileLocation()}${C.reset}\n`);

  // The always-bound invariant: a fresh login ends with a global default
  // project so every later command Just Works from any directory.
  if (!flags.noProject) {
    const saved = loadAuthForHost(hostName);
    if (saved?.token) {
      process.stdout.write('\n');
      await ensureDefaultProjectBinding(saved, {
        promptTitle: 'Pick your default project (used anywhere no directory is linked)',
      });
    }
  }
  return 0;
}

/**
 * Browser-callback login. Spawns a one-shot HTTP server on a random
 * localhost port, opens the dashboard's /cli/authorize page, waits for
 * the dashboard to POST the freshly-minted PAT back. Returns the token
 * or null on failure.
 */
async function browserLogin(apiBase: string, dashboardUrl?: string): Promise<string | null> {
  let session;
  try {
    session = await startCallbackServer();
  } catch (err) {
    process.stderr.write(
      `${status.err(`Could not start local callback: ${(err as Error).message}`)}\n`,
    );
    return null;
  }

  const dashUrl = webDashboardUrl(apiBase, dashboardUrl);
  const deviceLabel = encodeURIComponent(safeHostname());
  const url =
    `${dashUrl}/cli/authorize` +
    `?callback=${encodeURIComponent(`http://127.0.0.1:${session.port}/callback`)}` +
    `&state=${session.state}` +
    `&label=${deviceLabel}`;

  process.stdout.write(`\n  ${C.bold}Authorize Kortix CLI${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Opening your browser at:${C.reset}\n`);
  process.stdout.write(`  ${C.cyan}${url}${C.reset}\n\n`);
  process.stdout.write(`  ${C.dim}Waiting for approval (Ctrl+C to cancel)…${C.reset}\n`);

  openInBrowser(url);

  try {
    const result = await session.awaitToken;
    return result.token;
  } catch (err) {
    process.stderr.write(`\n${status.err((err as Error).message)}\n`);
    return null;
  }
}

function safeHostname(): string {
  const raw = hostname() || 'CLI';
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
}

function openInBrowser(url: string): void {
  // Only hand a real web URL to the OS opener — a value starting with '-' would
  // be read as a flag by open/xdg-open, and Windows `start` parses its argument,
  // so an unvalidated URL is a command-injection vector.
  if (!/^https?:\/\//i.test(url)) return;
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* user can copy-paste the URL from stdout */
  }
}
