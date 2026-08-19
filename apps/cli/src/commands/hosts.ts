import {
  DEFAULT_HOST_NAME,
  type Host,
  activeHostName,
  getHost,
  listHosts,
  removeHost,
  upsertHost,
  useHost,
  validateHostName,
} from '../api/config.ts';
import { emitJson, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { confirm, prompt } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';
import { selectFromList } from '../tui-select.ts';
import { performLogin, runLogin } from './login.ts';
import { performLogout } from './logout.ts';
import { performWhoami } from './whoami.ts';

const HELP = help`Usage: kortix hosts <subcommand> [options]

Authentication is per host — one set of stored credentials per Kortix
instance. The "active" host is what every other command operates on
unless you pass \`--host <name>\` per invocation. Sign in with
\`kortix hosts login\`; switch instance with \`kortix hosts use\`.

Built-in hosts (always exist):
  cloud                Kortix Cloud (https://api.kortix.com)
  selfhost             Your self-hosted stack (kortix self-host)
  local-dev            Local dev server (http://localhost:8008)
  kortix-internal-dev  Kortix-internal hosted dev (http://dev-api.kortix.com)

Authentication:
  login [<name>]                      Sign in to a host (browser flow or
    [--token <pat>] [--api <url>]      --token PAT). Defaults to the active
    [--no-project]                     host; an unknown <name> is registered
                                      and signed in (like \`add\` + login).
  logout [<name>]                     Clear a host's stored token (default:
                                      active).
  whoami [<name>]                     Show the signed-in user for a host
    [--json] [--token-only]            (default: active).

Subcommands:
  ls                                  List hosts + auth status (--json)
  use <name>                          Switch the active host
  add <name> --url <url>              Register a new host; with --login
    [--dashboard-url <url>] [--login]  run the browser flow immediately.
                                      Pass --dashboard-url for a self-host
                                      instance if \`kortix login\` opens the
                                      wrong origin (it otherwise guesses the
                                      frontend URL from the API URL's shape).
  rm <name>                           Remove a custom host; built-ins
                                      are reset instead
  info [<name>]                       Show one host (or the active) (--json)
  current                             Print the active host name (--json)

Global options:
  --json         Machine-readable JSON output (read subcommands).
  --force        Skip removal confirmation.
  -h, --help     Show this help.

Examples:
  kortix hosts login                  # sign in to the active host
  kortix hosts login selfhost         # sign in to a specific instance
  kortix hosts use selfhost
  kortix hosts use cloud
  kortix hosts whoami
  kortix projects ls --host selfhost
  kortix hosts ls
`;

const LOGIN_HELP = help`Usage: kortix hosts login [<name>] [options]

Authenticate a host (browser device flow or --token PAT). Defaults to
the active host when <name> is omitted; an unknown <name> is registered
and signed in (like \`kortix hosts add\` + login).

A fresh login walks the hierarchy DOWN: host ✓ → account (auto when you
belong to one, otherwise a prompt) → default project (prompt).

Options:
  --token <pat>     Skip the browser flow and authenticate with a token.
  --api <url>       API base URL for the host (default: stored host URL
                    or the cloud default). Required to register a brand
                    new host with a non-default URL.
  --account <slug>  Pick the active account non-interactively (skips the
                    "Select your active account" prompt).
  --no-project      Skip the default-project binding step at the end.
  -h, --help        Show this help.

Examples:
  kortix hosts login
  kortix hosts login selfhost --api http://localhost:13738
  kortix hosts login --token kortix_pat_... --account acme
`;

const LOGOUT_HELP = help`Usage: kortix hosts logout [<name>]

Clear a host's stored auth token. Defaults to the active host when
<name> is omitted.

Options:
  -h, --help        Show this help.
`;

const WHOAMI_HELP = help`Usage: kortix hosts whoami [<name>] [options]

Show the authenticated user + active account for a host. Defaults to the
active host when <name> is omitted.

Options:
  --json            Machine-readable JSON output.
  --token-only      Print only the active token context.
  -h, --help        Show this help.
`;

export async function runHosts(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 0 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case 'ls':
    case 'list':
      return hostsLs(takeFlagBool([...rest], ['--json']));
    case 'login':
      return hostsLogin(rest);
    case 'logout':
      return hostsLogout(rest);
    case 'whoami':
      return hostsWhoami(rest);
    case 'use':
    case 'switch':
      return hostsUse(rest[0]);
    case 'add':
      return hostsAdd(rest);
    case 'rm':
    case 'remove':
    case 'delete':
      return hostsRm(rest);
    case 'info':
    case 'show': {
      const restCopy = [...rest];
      const json = takeFlagBool(restCopy, ['--json']);
      return hostsInfo(restCopy[0], json);
    }
    case 'current':
      return hostsCurrent(takeFlagBool([...rest], ['--json']));
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── ls ───────────────────────────────────────────────────────────────────

function hostsLs(json = false): number {
  const rows = listHosts();
  if (json) {
    emitJson(rows.map((r) => hostJson(r.name, r.host, r.active)));
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write(
      `${C.dim}No hosts configured. Run \`kortix login\` or \`kortix self-host start\`.${C.reset}\n`,
    );
    return 0;
  }

  const nameW = Math.max(...rows.map((r) => r.name.length), 6);
  // Auth-status column: "✓ signed in as <user/email>" vs "○ not signed in".
  // Width is measured on the visible text (glyph + label), ANSI stripped.
  const statusText = (r: (typeof rows)[number]): string =>
    r.host.token
      ? `✓ ${r.host.user_email || r.host.user_id || 'signed in'}`
      : '○ not signed in';
  const statusW = Math.max(...rows.map((r) => statusText(r).length), 8);

  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('   NAME', nameW + 3)}   ${pad('STATUS', statusW)}   URL${C.reset}\n`,
  );
  for (const r of rows) {
    const mark = r.active ? `${C.green}● ${C.reset}` : '  ';
    const status_ = r.host.token
      ? `${C.green}✓${C.reset} ${r.host.user_email || r.host.user_id || 'signed in'}`
      : `${C.faded}○ not signed in${C.reset}`;
    process.stdout.write(
      `${mark}${pad(r.name, nameW)}   ${pad(status_, statusW)}   ${C.faded}${r.host.url}${C.reset}\n`,
    );
  }
  const active = rows.find((r) => r.active);
  process.stdout.write(
    `\n  ${C.green}●${C.reset}${C.dim} active   ${C.reset}${C.green}✓${C.reset}${C.dim} signed in   ${C.reset}${C.faded}○ not signed in${C.reset}`,
  );
  if (active) {
    process.stdout.write(
      `\n  ${C.dim}Sign in with ${C.reset}${C.cyan}kortix hosts login${C.reset}${C.dim}, switch with ${C.reset}${C.cyan}kortix hosts use <name>${C.reset}`,
    );
  }
  process.stdout.write('\n\n');
  return 0;
}

// ── use ──────────────────────────────────────────────────────────────────

async function hostsUse(name: string | undefined): Promise<number> {
  let target = name;
  if (!target) {
    const rows = listHosts();
    if (rows.length === 0) {
      process.stderr.write(`${status.err('No hosts configured.')}\n`);
      return 1;
    }
    const picked = await selectFromList<string>({
      title: 'Switch active host',
      items: rows.map((r) => ({
        value: r.name,
        label: r.active ? `${r.name}  ${C.green}●${C.reset}` : r.name,
        sublabel: `${r.host.user_email || r.host.user_id || '— (not logged in)'}  ${r.host.url}`,
      })),
      initialIndex: rows.findIndex((r) => r.active),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }
  if (!useHost(target)) {
    process.stderr.write(
      `${status.err(`Unknown host "${target}". Run \`kortix hosts ls\` to see configured hosts.`)}\n`,
    );
    return 1;
  }
  process.stdout.write(`${status.ok(`Active host is now ${C.bold}${target}${C.reset}`)}\n`);
  return 0;
}

// ── login / logout / whoami ────────────────────────────────────────────────
//
// Host-centric auth. These reuse the exact shared helpers the top-level
// `kortix login`/`logout`/`whoami` aliases call — the only difference is the
// host is a positional `<name>` here (defaulting to the active host) rather
// than a `--host <name>` flag.

async function hostsLogin(args: string[]): Promise<number> {
  const rest = [...args];
  if (takeFlagBool(rest, ['-h', '--help'])) {
    process.stdout.write(LOGIN_HELP);
    return 0;
  }
  let token: string | undefined;
  let api: string | undefined;
  let account: string | undefined;
  let noProject = false;
  try {
    token = takeFlagValue(rest, ['--token']);
    api = takeFlagValue(rest, ['--api', '--url']);
    account = takeFlagValue(rest, ['--account']);
    noProject = takeFlagBool(rest, ['--no-project']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.find((a) => !a.startsWith('-'));
  const hostName = positional ?? activeHostName() ?? DEFAULT_HOST_NAME;
  return performLogin({ hostName, token, api, account, noProject });
}

async function hostsLogout(args: string[]): Promise<number> {
  const rest = [...args];
  if (takeFlagBool(rest, ['-h', '--help'])) {
    process.stdout.write(LOGOUT_HELP);
    return 0;
  }
  const positional = rest.find((a) => !a.startsWith('-'));
  return performLogout(positional);
}

async function hostsWhoami(args: string[]): Promise<number> {
  const rest = [...args];
  if (takeFlagBool(rest, ['-h', '--help'])) {
    process.stdout.write(WHOAMI_HELP);
    return 0;
  }
  const json = takeFlagBool(rest, ['--json']);
  const tokenOnly = takeFlagBool(rest, ['--token-only']);
  const positional = rest.find((a) => !a.startsWith('-'));
  return performWhoami({ host: positional, json, tokenOnly });
}

// ── add ──────────────────────────────────────────────────────────────────

async function hostsAdd(args: string[]): Promise<number> {
  let url: string | undefined;
  let dashboardUrl: string | undefined;
  let runLoginFlow = false;
  let name: string | undefined;
  try {
    url = takeFlagValue(args, ['--url', '--api']);
    dashboardUrl = takeFlagValue(args, ['--dashboard-url']);
    runLoginFlow = removeBoolFlag(args, ['--login']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  name = args[0];

  if (!name) {
    process.stderr.write(`${status.err('Pass a host name.')}\n`);
    return 2;
  }

  try {
    validateHostName(name);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  if (getHost(name)) {
    process.stderr.write(
      `${status.err(`Host "${name}" already exists. Use \`kortix hosts rm ${name}\` first or pick a new name.`)}\n`,
    );
    return 1;
  }

  if (!url) {
    url = (await prompt(`API base URL for "${name}"`)).trim();
    if (!url) {
      process.stderr.write(`${status.err('No URL provided.')}\n`);
      return 1;
    }
  }
  try {
    new URL(url); // validate
  } catch {
    process.stderr.write(`${status.err(`"${url}" is not a valid URL.`)}\n`);
    return 1;
  }
  if (dashboardUrl) {
    try {
      new URL(dashboardUrl); // validate
    } catch {
      process.stderr.write(`${status.err(`"${dashboardUrl}" is not a valid URL.`)}\n`);
      return 1;
    }
  }

  // Persist an empty-credential placeholder so `--host <name>` resolves
  // before login. Subsequent `kortix login --host <name>` fills in token.
  //
  // `dashboard_url` (when passed) is the frontend/dashboard origin for this
  // host — pass it for a self-host instance so `kortix login`'s browser flow
  // opens the right origin instead of guessing one from the API URL's shape
  // (a guess that assumes cloud conventions and breaks for non-default local
  // ports; see web-url.ts). `kortix self-host` sets this automatically for
  // its own built-in `selfhost` host — only needed here for a manually added
  // host pointed at a self-host API the CLI didn't itself provision.
  const placeholder: Host = {
    url,
    token: '',
    user_id: '',
    user_email: '',
    account_id: '',
    ...(dashboardUrl ? { dashboard_url: dashboardUrl } : {}),
    logged_in_at: new Date().toISOString(),
  };
  upsertHost(name, placeholder, false);
  process.stdout.write(
    `${status.ok(`Added host ${C.bold}${name}${C.reset} ${C.faded}(${url})${C.reset}`)}\n`,
  );

  if (runLoginFlow) {
    process.stdout.write(`${C.dim}Running login flow for ${name}…${C.reset}\n\n`);
    return runLogin(['--host', name]);
  }

  process.stdout.write(
    `${C.dim}  Next: ${C.reset}${C.cyan}kortix login --host ${name}${C.reset}\n`,
  );
  return 0;
}

// ── rm ───────────────────────────────────────────────────────────────────

async function hostsRm(args: string[]): Promise<number> {
  let force = false;
  try {
    force = removeBoolFlag(args, ['--force', '-f']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const name = args[0];
  if (!name) {
    process.stderr.write(`${status.err('Pass a host name.')}\n`);
    return 2;
  }
  const host = getHost(name);
  if (!host) {
    process.stderr.write(`${status.err(`Unknown host "${name}".`)}\n`);
    return 1;
  }

  const isActive = activeHostName() === name;
  const remaining = listHosts().length - 1;
  if (isActive && remaining === 0 && !force) {
    process.stdout.write(
      `${C.dim}Removing the last host (${name}) — you'll be fully logged out.${C.reset}\n`,
    );
    const ok = await confirm('Proceed?', false);
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }

  const result = removeHost(name);
  if (!result.removed) {
    process.stderr.write(`${status.err(`Could not remove "${name}".`)}\n`);
    return 1;
  }
  process.stdout.write(`${status.ok(`Removed ${C.bold}${name}${C.reset}`)}\n`);
  if (result.switchedTo) {
    process.stdout.write(
      `${C.dim}  Active host is now ${C.reset}${C.bold}${result.switchedTo}${C.reset}\n`,
    );
  } else if (isActive) {
    process.stdout.write(
      `${C.dim}  Built-in host reset; run ${C.cyan}kortix login --host ${name}${C.reset}${C.dim} to authenticate again.${C.reset}\n`,
    );
  }
  return 0;
}

// ── info ─────────────────────────────────────────────────────────────────

function hostsInfo(name: string | undefined, json = false): number {
  const target = name ?? activeHostName();
  if (!target) {
    process.stderr.write(
      `${status.err('No host configured. Pass a name or run `kortix login`.')}\n`,
    );
    return 1;
  }
  const host = getHost(target);
  if (!host) {
    process.stderr.write(`${status.err(`Unknown host "${target}".`)}\n`);
    return 1;
  }

  const active = activeHostName() === target;
  if (json) {
    emitJson(hostJson(target, host, active));
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.bold}${target}${C.reset}${active ? `  ${C.green}● active${C.reset}` : ''}\n`,
  );
  process.stdout.write(`  ${C.dim}url        ${C.reset}${host.url}\n`);
  if (host.dashboard_url) {
    process.stdout.write(`  ${C.dim}dashboard  ${C.reset}${host.dashboard_url}\n`);
  }
  process.stdout.write(
    `  ${C.dim}user       ${C.reset}${host.user_email || host.user_id || '— (not logged in)'}\n`,
  );
  if (host.account_id) {
    process.stdout.write(`  ${C.dim}account_id ${C.reset}${host.account_id}\n`);
  }
  process.stdout.write(
    `  ${C.dim}token      ${C.reset}${host.token ? `${host.token.slice(0, 18)}…` : '— (none)'}\n`,
  );
  process.stdout.write(`  ${C.dim}logged in  ${C.reset}${host.logged_in_at}\n\n`);
  return 0;
}

function hostsCurrent(json = false): number {
  const name = activeHostName();
  if (!name) {
    process.stderr.write(`${status.err('No active host.')}\n`);
    return 1;
  }
  if (json) {
    const host = getHost(name);
    emitJson(host ? hostJson(name, host, true) : { name, active: true });
    return 0;
  }
  process.stdout.write(`${name}\n`);
  return 0;
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Shape a host for JSON output. Never includes the raw token value. */
function hostJson(name: string, host: Host, active: boolean) {
  return {
    name,
    url: host.url,
    dashboard_url: host.dashboard_url || null,
    user_email: host.user_email || null,
    user_id: host.user_id || null,
    account_id: host.account_id || null,
    logged_in: Boolean(host.token),
    logged_in_at: host.logged_in_at || null,
    active,
  };
}

function removeBoolFlag(argv: string[], names: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (names.includes(argv[i])) {
      argv.splice(i, 1);
      return true;
    }
  }
  return false;
}
