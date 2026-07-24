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
import type { AccountMembership, MeResponse } from '../api/types.ts';
import { ensureDefaultProjectBinding } from '../project-bind.ts';
import { C, help, status } from '../style.ts';
import { selectFromList } from '../tui-select.ts';
import { webDashboardUrl } from '../web-url.ts';

const HELP = help`Usage: kortix login [options]

Authenticate the CLI against the Kortix cloud. Browser opens to the
dashboard, one click authorizes this CLI, the token is sent back to a
local callback — no copy/paste.

Shortcut for the active host — same as \`kortix hosts login\`. Use
\`kortix hosts login <name>\` to sign in to a different instance.

Options:
  --host <name>     Save under a specific named host (default: active or
                    "${DEFAULT_HOST_NAME}"). Use this to add a second
                    instance: \`kortix login --host local --api …\`.
  --api <url>       API base URL the host points at (default: stored
                    host URL or ${DEFAULT_API_BASE}).
  --token <pat>     Skip the browser flow and authenticate directly
                    with a token. Useful for CI or headless boxes.
  --account <slug>  Pick the active account non-interactively (skips the
                    post-login "Select your active account" prompt).
  --no-project      Skip the default-project binding step at the end.
  -h, --help        Show this help.

A fresh login walks the hierarchy DOWN: host ✓ → account (auto when you
belong to one, otherwise a prompt) → default project (prompt).

Examples:
  kortix login
  kortix login --host local --api http://localhost:8008
  kortix login --token kortix_pat_... --account acme
`;

interface LoginFlags {
  token?: string;
  api?: string;
  host?: string;
  account?: string;
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
    } else if (a === '--account') {
      const next = argv[i + 1];
      if (!next) throw new Error('--account requires a value');
      f.account = next;
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

  // Resolve which host we're logging into (top-level `login` selects it via
  // `--host`; the active host is the default). The `hosts login <name>`
  // subcommand resolves the target the same way and calls `performLogin`.
  const hostName = flags.host ?? activeHostName() ?? DEFAULT_HOST_NAME;
  return performLogin({
    hostName,
    token: flags.token,
    api: flags.api,
    account: flags.account,
    noProject: flags.noProject,
  });
}

export interface PerformLoginOptions {
  /** The host name to authenticate (already resolved by the caller). */
  hostName: string;
  /** Skip the browser flow and authenticate directly with this PAT. */
  token?: string;
  /** API base URL override for the host. */
  api?: string;
  /** Pick the active account non-interactively (slug or id). */
  account?: string;
  /** Skip the default-project binding step at the end. */
  noProject: boolean;
}

/**
 * Shared login implementation used by both the top-level `kortix login`
 * alias and the `kortix hosts login` subcommand. The caller resolves the
 * target host name; everything else — API base resolution, the already
 * logged-in short-circuit, the browser/PAT flow, token verification,
 * persistence, and the default-project binding — lives here so the two
 * entry points can never drift.
 */
export async function performLogin(opts: PerformLoginOptions): Promise<number> {
  const { hostName } = opts;
  try {
    validateHostName(hostName);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  // Pick the API base URL with this priority:
  //   --api flag → existing host's URL → KORTIX_API_URL env → default
  const existing = getHost(hostName);
  const apiBase = opts.api ?? existing?.url ?? process.env.KORTIX_API_URL ?? DEFAULT_API_BASE;

  // If this host already has a working token + caller didn't pass
  // --token or --api, treat that as a no-op login.
  if (existing?.token && !opts.token && !opts.api) {
    process.stdout.write(
      `${status.info(`Already logged in to host ${C.bold}${hostName}${C.reset} as ${C.bold}${existing.user_email || existing.user_id}${C.reset}`)}\n`,
    );
    process.stdout.write(
      `${C.dim}  Run \`kortix logout --host ${hostName}\` first to switch accounts.${C.reset}\n`,
    );
    return 0;
  }

  const token = opts.token ?? (await browserLogin(apiBase, existing?.dashboard_url));
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

  // Persist the verified token immediately so the host is authenticated even
  // if the account/project selection below is interrupted (Ctrl+C on the
  // prompt still leaves you signed in).
  saveAuthForHost(
    hostName,
    {
      api_base: apiBase,
      token,
      user_id: me.user_id,
      user_email: me.email,
      account_id: '',
      logged_in_at: new Date().toISOString(),
    },
    /* makeActive */ true,
  );

  process.stdout.write(
    `\n${status.ok(`Logged in to host ${C.bold}${hostName}${C.reset} as ${C.bold}${me.email || me.user_id}${C.reset}`)}\n`,
  );

  // The account step of the funnel: exactly one → auto-select; several →
  // prompt (or honor --account). Persist the active account's display fields
  // (and reconcile any default project) so the context block + `accounts ls`
  // read correctly offline.
  const selected = await resolveLoginAccount(me.accounts, opts.account);
  if (selected) {
    setActiveAccount(
      { id: selected.account_id, slug: selected.slug, name: selected.name },
      hostName,
    );
    process.stdout.write(
      `${C.dim}  Active account: ${C.reset}${selected.name} ${C.faded}(${selected.slug})${C.reset}\n`,
    );
  }
  process.stdout.write(`${C.dim}  Stored at ${authFileLocation()}${C.reset}\n`);

  // The always-bound invariant: a fresh login ends with a global default
  // project so every later command Just Works from any directory.
  if (!opts.noProject) {
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
 * The account step of the login funnel. One login can belong to many
 * accounts, but exactly one is active. Resolution:
 *   - zero accounts        → null (nothing to select)
 *   - `--account <slug>`   → match by slug/id; unknown value warns + falls
 *                            back to the first account (login still succeeds)
 *   - exactly one          → auto-select it (no prompt)
 *   - several + TTY        → interactive "Select your active account" prompt
 *                            (Ctrl+C/Esc falls back to the first account)
 *   - several + non-TTY    → first account, with a hint to switch later
 * Never throws and always leaves the login with an active account when the
 * user belongs to any, matching the historical always-pick-one behavior.
 */
async function resolveLoginAccount(
  accounts: AccountMembership[],
  accountFlag: string | undefined,
): Promise<AccountMembership | null> {
  if (accounts.length === 0) return null;

  if (accountFlag) {
    const found = accounts.find((a) => a.slug === accountFlag || a.account_id === accountFlag);
    if (found) return found;
    const known = accounts.map((a) => a.slug).join(', ');
    process.stderr.write(
      `${status.warn(`No account "${accountFlag}" on this host — known: ${known}. Using ${accounts[0]!.name}.`)}\n`,
    );
    return accounts[0]!;
  }

  if (accounts.length === 1) return accounts[0]!;

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    process.stdout.write(
      `${C.dim}  ${accounts.length} accounts — kept ${accounts[0]!.name}. Switch with ${C.reset}${C.cyan}kortix accounts use <slug>${C.reset}${C.dim} (or pass \`--account\`).${C.reset}\n`,
    );
    return accounts[0]!;
  }

  const picked = await selectFromList<AccountMembership>({
    title: 'Select your active account',
    items: accounts.map((a) => ({
      value: a,
      label: a.name,
      sublabel: `${a.slug} · ${a.role}`,
    })),
    initialIndex: 0,
  });
  return picked ?? accounts[0]!;
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
