import {
  activeHostName,
  getHost,
  listHosts,
  removeHost,
  upsertHost,
  useHost,
  validateHostName,
  type Host,
} from '../api/config.ts';
import { confirm, prompt } from '../prompts.ts';
import { selectFromList } from '../tui-select.ts';
import { C, pad, status } from '../style.ts';
import { takeFlagValue } from '../command-helpers.ts';
import { runLogin } from './login.ts';

const HELP = `Usage: kortix hosts <subcommand> [options]

Manage Kortix API hosts — one set of stored credentials per Kortix
instance. The "active" host is what every other command operates on
unless you pass \`--host <name>\` per invocation.

Subcommands:
  ls                                  List hosts (cloud/local/dev always exist)
  use <name>                          Switch the active host
  add <name> --url <url> [--login]    Register a new host; with --login
                                      run the browser flow immediately
  rm <name>                           Remove a custom host; built-in
                                      cloud/local/dev are reset instead
  info [<name>]                       Show one host (or the active)
  current                             Print the active host name

Global options:
  --force        Skip removal confirmation.
  -h, --help     Show this help.

Examples:
  kortix hosts use local
  kortix hosts use dev
  kortix hosts use cloud
  kortix projects ls --host dev
  kortix projects ls --host local
  kortix hosts ls
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
      return hostsLs();
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
    case 'show':
      return hostsInfo(rest[0]);
    case 'current':
      return hostsCurrent();
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── ls ───────────────────────────────────────────────────────────────────

function hostsLs(): number {
  const rows = listHosts();
  if (rows.length === 0) {
    process.stdout.write(
      `${C.dim}No hosts configured. Run \`kortix login\` or \`kortix self-host start\`.${C.reset}\n`,
    );
    return 0;
  }

  const nameW = Math.max(...rows.map((r) => r.name.length), 6);
  const userW = Math.max(
    ...rows.map((r) => (r.host.user_email || r.host.user_id || '—').length),
    8,
  );

  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('   NAME', nameW + 3)}   ${pad('USER', userW)}   URL${C.reset}\n`,
  );
  for (const r of rows) {
    const mark = r.active ? `${C.green}● ${C.reset}` : '  ';
    const user = r.host.user_email || r.host.user_id || '—';
    process.stdout.write(
      `${mark}${pad(r.name, nameW)}   ${pad(user, userW)}   ${C.faded}${r.host.url}${C.reset}\n`,
    );
  }
  const active = rows.find((r) => r.active);
  process.stdout.write(`\n  ${C.green}●${C.reset}${C.dim} active${C.reset}`);
  if (active) {
    process.stdout.write(`${C.dim}: ${C.reset}${C.bold}${active.name}${C.reset}${C.dim} -> ${active.host.url}${C.reset}`);
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

// ── add ──────────────────────────────────────────────────────────────────

async function hostsAdd(args: string[]): Promise<number> {
  let url: string | undefined;
  let runLoginFlow = false;
  let name: string | undefined;
  try {
    url = takeFlagValue(args, ['--url', '--api']);
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

  // Persist an empty-credential placeholder so `--host <name>` resolves
  // before login. Subsequent `kortix login --host <name>` fills in token.
  const placeholder: Host = {
    url,
    token: '',
    user_id: '',
    user_email: '',
    account_id: '',
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
    process.stdout.write(`${C.dim}  Built-in host reset; run ${C.cyan}kortix login --host ${name}${C.reset}${C.dim} to authenticate again.${C.reset}\n`);
  }
  return 0;
}

// ── info ─────────────────────────────────────────────────────────────────

function hostsInfo(name: string | undefined): number {
  const target = name ?? activeHostName();
  if (!target) {
    process.stderr.write(`${status.err('No host configured. Pass a name or run `kortix login`.')}\n`);
    return 1;
  }
  const host = getHost(target);
  if (!host) {
    process.stderr.write(`${status.err(`Unknown host "${target}".`)}\n`);
    return 1;
  }

  const active = activeHostName() === target;
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.bold}${target}${C.reset}${active ? `  ${C.green}● active${C.reset}` : ''}\n`,
  );
  process.stdout.write(`  ${C.dim}url        ${C.reset}${host.url}\n`);
  process.stdout.write(`  ${C.dim}user       ${C.reset}${host.user_email || host.user_id || '— (not logged in)'}\n`);
  if (host.account_id) {
    process.stdout.write(`  ${C.dim}account_id ${C.reset}${host.account_id}\n`);
  }
  process.stdout.write(`  ${C.dim}token      ${C.reset}${host.token ? `${host.token.slice(0, 18)}…` : '— (none)'}\n`);
  process.stdout.write(`  ${C.dim}logged in  ${C.reset}${host.logged_in_at}\n\n`);
  return 0;
}

function hostsCurrent(): number {
  const name = activeHostName();
  if (!name) {
    process.stderr.write(`${status.err('No active host.')}\n`);
    return 1;
  }
  process.stdout.write(`${name}\n`);
  return 0;
}

// ── helpers ───────────────────────────────────────────────────────────────

function removeBoolFlag(argv: string[], names: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (names.includes(argv[i])) {
      argv.splice(i, 1);
      return true;
    }
  }
  return false;
}
