import { hostname } from 'node:os';

import {
  DEFAULT_API_BASE,
  authFileLocation,
  loadAuthForHost,
  saveAuthForHost,
  sameApiBase,
} from '../api/auth.ts';
import { cliDeviceRequest } from '../api/sdk.ts';
import { pollDeviceGrant, type DevicePollAnswer } from './device-login-poll.ts';
import { startCallbackServer } from '../api/browser-auth.ts';
import { ApiError, createApiClient } from '../api/client.ts';
import {
  DEFAULT_HOST_NAME,
  activeHostName,
  getHost,
  setActiveAccount,
  useHost,
  validateHostName,
} from '../api/config.ts';
import type { AccountMembership, MeResponse } from '../api/types.ts';
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue, fail } from '../command-helpers.ts';
import { NO_WORKSPACE_CODE, NO_WORKSPACE_LINE, noWorkspaceLoginLine } from '../api/no-workspace.ts';
import { ensureDefaultProjectBinding } from '../project-bind.ts';
import { C, help, status } from '../style.ts';
import { deriveFrontendFromApiBase } from '../web-url.ts';
import { openInBrowser } from '../browser.ts';

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
  --device          Authorize from any browser, without a local callback.
  --token <pat>     Skip the browser flow and authenticate directly
                    with a token. Useful for CI or headless boxes.
  --account <slug>  Bind a workspace of this account (legacy account slug
                    or id) instead of asking.
  --no-workspace    Skip the default-workspace step at the end.
                    --no-project is the older name.
  -h, --help        Show this help.

A fresh login walks the hierarchy DOWN: host ✓ → default workspace (auto
when you belong to one, otherwise a prompt). With no workspace yet, it
says how to create or join one.

Examples:
  kortix login
  kortix login --host local --api http://localhost:8008
  kortix login --token kortix_pat_... --account acme
`;

export async function runLogin(argv: string[]): Promise<number> {
  const flags = takeFlags(argv, HELP, (rest) => ({
    host: takeFlagValue(rest, ['--host']),
    api: takeFlagValue(rest, ['--api']),
    token: takeFlagValue(rest, ['--token']),
    account: takeFlagValue(rest, ['--account']),
    noProject: takeFlagBool(rest, ['--no-workspace', '--no-project']),
    device: takeFlagBool(rest, ['--device']),
  }));
  if (typeof flags === 'number') return flags;

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
    device: flags.device,
  });
}

interface PerformLoginOptions {
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
  device?: boolean;
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
    return fail((err as Error).message);
  }

  // Pick the API base URL with this priority:
  //   --api flag → KORTIX_API_URL env (active host only, as `activeHost()`
  //   does) → existing host's URL → default. Built-in hosts always exist, so
  //   an existing host's URL must not outrank the env override: the token
  //   would go to the default API instead of the one the caller named.
  const existing = getHost(hostName);
  const envApiBase =
    hostName === (activeHostName() ?? DEFAULT_HOST_NAME) ? process.env.KORTIX_API_URL?.trim() || undefined : undefined;
  const apiBase = opts.api ?? envApiBase ?? existing?.url ?? DEFAULT_API_BASE;

  // If this host already has a working token + caller didn't pass
  // --token or --api, treat that as a no-op login.
  if (existing?.token && !opts.token && !opts.api) {
    useHost(hostName);
    process.stdout.write(
      `${status.info(`Already logged in to host ${C.bold}${hostName}${C.reset} as ${C.bold}${existing.user_email || existing.user_id}${C.reset}`)}\n`,
    );
    process.stdout.write(
      `${C.dim}  Run \`kortix logout --host ${hostName}\` first to switch accounts.${C.reset}\n`,
    );
    return 0;
  }

  const dashboardUrl = existing && sameApiBase(apiBase, existing.url) ? existing.dashboard_url : undefined;
  const token = opts.token ?? (await (opts.device ? deviceLogin(apiBase, dashboardUrl) : browserLogin(apiBase, dashboardUrl)));
  if (!token) return 1;

  if (!token.startsWith('kortix_pat_') && !token.startsWith('kortix_sa_')) {
    process.stderr.write(
      `${status.err('Invalid API key format — expected `kortix_pat_...` or `kortix_sa_...` prefix.')}\n`,
    );
    return 1;
  }

  // Verify the token + capture identity for the host record.
  const client = createApiClient({ apiBase, token });
  let me: MeResponse;
  try {
    me = await client.get<MeResponse>('/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // The server's verdict names the credential ("project token <id> is
      // revoked") — the token was pasted moments ago, so name it inline.
      const why = err.message ? ` — ${err.message}` : '';
      process.stderr.write(`${status.err(`Token rejected by the API${why}. Try again.`)}\n`);
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
  useHost(hostName);

  const loginIdentity = me.token_context?.agent
    ? `agent ${C.bold}${me.token_context.agent}${C.reset} ` +
      `(initiator: ${C.bold}${me.email || me.user_id}${C.reset})`
    : C.bold + (me.email || me.user_id) + C.reset;
  process.stdout.write(
    `\n${status.ok(`Logged in to host ${C.bold}${hostName}${C.reset} as ${loginIdentity}`)}\n`,
  );

  // A new user belongs to no workspace (no account is created at signup):
  // the login holds, and the next step is to create or join one.
  if ((me.accounts ?? []).length === 0) {
    process.stdout.write(`${C.dim}  Stored at ${authFileLocation()}${C.reset}\n\n`);
    process.stdout.write(`${status.info(NO_WORKSPACE_LINE)}\n`);
    return 0;
  }

  // The account behind the workspace: exactly one → auto-select; --account →
  // that one; several → the workspace step below picks it (and the account
  // comes with it). Persist the active account's display fields so the
  // context block reads correctly offline.
  const selected = await resolveLoginAccount(me.accounts, opts.account, !opts.noProject);
  if (selected) {
    setActiveAccount(
      { id: selected.account_id, slug: selected.slug, name: selected.name },
      hostName,
    );
  }
  process.stdout.write(`${C.dim}  Stored at ${authFileLocation()}${C.reset}\n`);

  // The always-bound invariant: a fresh login ends with a global default
  // workspace so every later command Just Works from any directory.
  if (!opts.noProject) {
    const saved = loadAuthForHost(hostName);
    if (saved?.token) {
      process.stdout.write('\n');
      await ensureDefaultProjectBinding(saved, {
        promptTitle: 'Pick your default workspace (used anywhere no directory is linked)',
        accountId: opts.account ? selected?.account_id : undefined,
      });
    }
  }
  return 0;
}

/**
 * The account behind the login's workspace. Resolution:
 *   - zero accounts        → null (no workspace; the caller says so)
 *   - `--account <slug>`   → match by slug/id; unknown value warns + falls
 *                            back to the first account (login still succeeds)
 *   - exactly one          → auto-select it (no prompt)
 *   - several              → null when the workspace step follows (it picks
 *                            the workspace, and the account comes with it);
 *                            else the first account, with a hint to switch
 * Never throws.
 */
async function resolveLoginAccount(
  accounts: AccountMembership[],
  accountFlag: string | undefined,
  workspaceStepFollows: boolean,
): Promise<AccountMembership | null> {
  if (accounts.length === 0) return null;

  if (accountFlag) {
    const found = accounts.find((a) => a.slug === accountFlag || a.account_id === accountFlag);
    if (found) return found;
    const known = accounts.map((a) => a.slug).join(', ');
    process.stderr.write(
      `${status.warn(`No account "${accountFlag}" on this host. Known: ${known}. Using ${accounts[0]!.name}.`)}\n`,
    );
    return accounts[0]!;
  }

  if (accounts.length === 1) return accounts[0]!;
  if (workspaceStepFollows) return null;

  process.stdout.write(
    `${C.dim}  ${accounts.length} workspaces. Kept ${accounts[0]!.name}. Switch with ${C.reset}${C.cyan}kortix workspaces use${C.reset}${C.dim}.${C.reset}\n`,
  );
  return accounts[0]!;
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
    process.stderr.write("Run `kortix login --device` to authorize without a local callback.\n");
    return null;
  }

  // Login targets the selected host, not the deployment running this shell.
  const dashUrl = dashboardUrl?.trim().replace(/\/+$/, '') || deriveFrontendFromApiBase(apiBase);
  const deviceLabel = encodeURIComponent(safeHostname());
  const url =
    `${dashUrl}/cli/authorize` +
    // `cli.localhost`, never a bare `127.0.0.1`/`localhost`: the Cloudflare WAF
    // in front of every non-prod origin 403s a query string carrying either of
    // those hosts, so the authorize page never rendered and `kortix login`
    // could not complete against dev or staging at all. A `.localhost`
    // subdomain is loopback by RFC 6761 and clears the rule.
    `?callback=${encodeURIComponent(`http://cli.localhost:${session.port}/callback`)}` +
    `&state=${session.state}` +
    `&label=${deviceLabel}`;

  process.stdout.write(`\n  ${C.bold}Authorize Kortix CLI${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Opening your browser at:${C.reset}\n`);
  process.stdout.write(`  ${C.cyan}${url}${C.reset}\n\n`);
  process.stdout.write(`  ${C.dim}Waiting for approval (Ctrl+C to cancel)…${C.reset}\n`);
  process.stdout.write('  Remote shell? Cancel and run `kortix login --device` (no local callback).\n');

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

/** Device login never opens a listening socket. The polling secret stays in
 * this process; the browser receives only the separate approval code. */
async function deviceLogin(apiBase: string, dashboardUrl?: string): Promise<string | null> {
  const deadline = Date.now() + 600_000;
  const signal = AbortSignal.timeout(600_000);
  try {
    const grant = await cliDeviceRequest<{ device_code: string; user_code: string; expires_in?: number; interval?: number; verification_uri?: string }>(apiBase, 'start', {}, signal);
    const dash = dashboardUrl?.trim().replace(/\/+$/, '') || deriveFrontendFromApiBase(apiBase);
    const approvalPage = grant.verification_uri || `${dash}/cli/authorize`;
    const url = `${approvalPage}?user_code=${encodeURIComponent(grant.user_code)}`;
    process.stdout.write(`\nOpen ${url} in any browser.\nConfirm code: ${grant.user_code}\nWaiting for approval (Ctrl+C to cancel)…\n`);
    openInBrowser(url);
    try {
      return await pollDeviceGrant(grant, {
        poll: () => cliDeviceRequest<DevicePollAnswer>(apiBase, 'poll', { device_code: grant.device_code }, signal),
        sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
        now: Date.now,
      }, deadline);
    } catch (err) {
      // no_workspace (a 409, or the poll answer's error): the approver has no
      // workspace, so no key exists yet and `kortix workspaces create` cannot
      // run. Point at the web.
      const message = (err as Error).message;
      if (message === NO_WORKSPACE_LINE || message === NO_WORKSPACE_CODE) throw new Error(noWorkspaceLoginLine(dash));
      throw err;
    }
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return null;
  }
}
