import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import { DEFAULT_API_BASE, authFileLocation, loadAuth, saveAuth } from '../api/auth.ts';
import { ApiError, createApiClient } from '../api/client.ts';
import { startCallbackServer } from '../api/browser-auth.ts';
import { C, status } from '../style.ts';
import type { MeResponse } from '../api/types.ts';

const HELP = `Usage: kortix login [options]

Authenticate the CLI against the Kortix cloud.

By default this opens your browser to the Kortix dashboard, where one
click authorizes this CLI and a token is sent back to a temporary
local callback. No copy-paste.

Options:
  --token <pat>     Skip the browser flow and authenticate directly
                    with a token. Useful for CI or headless boxes.
  --api <url>       Override the API base URL (default: ${DEFAULT_API_BASE}).
  -h, --help        Show this help.

Examples:
  kortix login
  kortix login --token kortix_pat_...
  kortix login --api http://localhost:8000
`;

interface LoginFlags {
  token?: string;
  api?: string;
  help: boolean;
}

function parseFlags(argv: string[]): LoginFlags {
  const f: LoginFlags = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') f.help = true;
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

  const apiBase = flags.api ?? process.env.KORTIX_API_URL ?? DEFAULT_API_BASE;

  const existing = loadAuth();
  if (existing?.token && !flags.token) {
    process.stdout.write(
      `${status.info(`Already logged in as ${C.bold}${existing.user_email || existing.user_id}${C.reset}${C.dim} (token at ${authFileLocation()})${C.reset}`)}\n`,
    );
    process.stdout.write(`${C.dim}Run \`kortix logout\` first to switch accounts.${C.reset}\n`);
    return 0;
  }

  const token = flags.token ?? (await browserLogin(apiBase));
  if (!token) return 1;

  if (!token.startsWith('kortix_pat_')) {
    process.stderr.write(
      `${status.err('Invalid token format — expected `kortix_pat_...` prefix.')}\n`,
    );
    return 1;
  }

  // Verify the token + capture identity for the auth file.
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
  saveAuth({
    api_base: apiBase,
    token,
    user_id: me.user_id,
    user_email: me.email,
    account_id: primary?.account_id ?? '',
    logged_in_at: new Date().toISOString(),
  });

  process.stdout.write(`\n${status.ok(`Logged in as ${C.bold}${me.email || me.user_id}${C.reset}`)}\n`);
  if (primary) {
    process.stdout.write(
      `${C.dim}  Active account: ${C.reset}${primary.name} ${C.faded}(${primary.slug})${C.reset}\n`,
    );
  }
  process.stdout.write(`${C.dim}  Stored at ${authFileLocation()}${C.reset}\n`);
  return 0;
}

/**
 * Browser-callback login. Spawns a one-shot HTTP server on a random
 * localhost port, opens the dashboard's /cli/authorize page, waits for
 * the dashboard to POST the freshly-minted PAT back. Returns the token
 * or null on failure.
 */
async function browserLogin(apiBase: string): Promise<string | null> {
  let session;
  try {
    session = await startCallbackServer();
  } catch (err) {
    process.stderr.write(
      `${status.err(`Could not start local callback: ${(err as Error).message}`)}\n`,
    );
    return null;
  }

  const dashUrl = webDashboardUrl(apiBase);
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

/** Best-effort mapping of api.kortix.com → kortix.com for the dashboard link. */
function webDashboardUrl(apiBase: string): string {
  // Local dev: api at :8008 → dashboard at :3000.
  try {
    const url = new URL(apiBase);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      const devPort = process.env.KORTIX_DASHBOARD_URL;
      if (devPort) return devPort.replace(/\/$/, '');
      return `${url.protocol}//${url.hostname}:3000`;
    }
    if (url.hostname.startsWith('api.')) {
      url.hostname = url.hostname.slice(4);
      return url.origin;
    }
    return url.origin;
  } catch {
    return 'https://kortix.com';
  }
}

function openInBrowser(url: string): void {
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
