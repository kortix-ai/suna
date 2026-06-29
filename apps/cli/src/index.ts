#!/usr/bin/env bun
import { runAccess } from './commands/access.ts';
import { runAccounts } from './commands/accounts.ts';
import { runApps } from './commands/apps.ts';
import { runChannels } from './commands/channels.ts';
import { runConnectors } from './commands/connectors.ts';
import { runCr } from './commands/cr.ts';
import { runCreate } from './commands/create.ts';
import { runDev } from './commands/dev.ts';
import { runEnv } from './commands/env.ts';
import { runExecutor } from './commands/executor.ts';
import { runFiles } from './commands/files.ts';
import { runHosts } from './commands/hosts.ts';
import { runInit } from './commands/init.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runMarketplace } from './commands/marketplace.ts';
import { runProjects } from './commands/projects.ts';
import { runRegistry } from './commands/registry.ts';
import { runRoles } from './commands/roles.ts';
import { runSandboxes } from './commands/sandboxes.ts';
import { runSecrets } from './commands/secrets.ts';
import { runSelfHost } from './commands/self-host.ts';
import { runSessions } from './commands/sessions.ts';
import { runSessionsChat } from './commands/sessions-chat.ts';
import { runShip } from './commands/ship.ts';
import { runTriggers } from './commands/triggers.ts';
import { runTunnel } from './commands/tunnel.ts';
import { runUninstall } from './commands/uninstall.ts';
import { runUpdate } from './commands/update.ts';
import { runValidate } from './commands/validate.ts';
import { runWhoami } from './commands/whoami.ts';
import { printBanner } from './banner.ts';
import { getUpdateNotice } from './update-check.ts';
import { renderContext, renderHostNotice } from './host-notice.ts';
import { C, header, pad, rule } from './style.ts';

// CI bakes the real version via --define process.env.KORTIX_CLI_VERSION (the
// unified X.Y.Z on release, X.Y.Z-dev.<sha> on dev). This fallback only applies
// to a bare `bun run src/index.ts` during local dev.
const VERSION = process.env.KORTIX_CLI_VERSION ?? 'dev';

interface Command {
  name: string;
  args?: string;
  blurb: string;
}

const COMMANDS: readonly Command[] = [
  { name: 'init', blurb: 'Start a new Kortix project (a fresh standalone directory)' },
  { name: '<project-name>', blurb: 'Create a new directory and scaffold it' },
  { name: 'ship', blurb: 'Create the cloud project (first run) + push your code' },
  { name: 'validate', blurb: 'Statically validate this project\'s kortix.toml' },
  { name: 'dev', args: '[opencode args…]', blurb: 'Run OpenCode locally against this config (test agents/skills/tools)' },
  { name: 'self-host', args: '<subcommand>', blurb: 'Run your own Kortix Cloud from Docker images' },
  { name: 'login', blurb: 'Authenticate against the Kortix cloud' },
  { name: 'logout', blurb: 'Remove the stored auth token' },
  { name: 'whoami', blurb: 'Show the currently authenticated user' },
  { name: 'token', blurb: 'Show the active token context (project/session/agent grants)' },
  { name: 'hosts', args: '<subcommand>', blurb: 'Manage + switch Kortix API hosts' },
  { name: 'accounts', args: '<subcommand>', blurb: 'List + switch the active account (multi-account logins)' },
  { name: 'projects', args: '<subcommand>', blurb: 'List, link, set-default, open Kortix cloud projects' },
  { name: 'secrets', args: '<subcommand>', blurb: 'Manage project secrets (project-scoped)' },
  { name: 'env', args: '<subcommand>', blurb: 'Pull/push project secrets as a dotenv file' },
  { name: 'sessions', args: '<subcommand>', blurb: 'List, create, restart project sessions' },
  { name: 'chat', args: '[session-id]', blurb: 'Talk to a session\'s agent (REPL or --prompt)' },
  { name: 'files', args: '<subcommand>', blurb: 'Browse repo files, commits, branches, diffs' },
  { name: 'triggers', args: '<subcommand>', blurb: 'List, fire, enable/disable triggers' },
  { name: 'channels', args: '<subcommand>', blurb: 'Connect Slack to this project (status/connect/disconnect/manifest)' },
  { name: 'connectors', args: '<subcommand>', blurb: 'Manage integrations agents call as tools (Pipedream/MCP/HTTP)' },
  { name: 'executor', args: '<subcommand>', blurb: 'Call connectors as tools (discover/describe/call) + run the MCP server' },
  { name: 'marketplace', args: '<subcommand>', blurb: 'Search, show, install, and inspect marketplace items' },
  { name: 'sandboxes', args: '<subcommand>', blurb: 'Manage sandbox images: templates, builds, health' },
  { name: 'apps', args: '<subcommand>', blurb: 'Manage deployable apps (experimental)' },
  { name: 'cr', args: '<subcommand>', blurb: 'Open, review, merge change requests' },
  { name: 'access', args: '<subcommand>', blurb: 'Manage who can use this project (invite/grant/revoke)' },
  { name: 'roles', args: '<subcommand>', blurb: 'Manage IAM custom roles + policy assignments (account-scoped)' },
  { name: 'tunnel', args: '<subcommand>', blurb: 'See & drive your fleet of registered computers (Agent Tunnel)' },
  { name: 'update', blurb: 'Pull the latest CLI from kortix.com/install' },
  { name: 'uninstall', blurb: 'Remove the Kortix CLI from this machine' },
  { name: 'help', blurb: 'Show this help' },
  { name: 'version', blurb: 'Print the CLI version' },
] as const;

function renderHelp(): string {
  const labelWidth = Math.max(
    ...COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name).length),
  );
  const lines: string[] = [];
  lines.push('');
  lines.push(header('Kortix CLI', VERSION));
  lines.push(rule());
  lines.push('');
  for (const cmd of COMMANDS) {
    const label = cmd.args ? `${cmd.name} ${C.faded}${cmd.args}${C.reset}` : cmd.name;
    lines.push(`  ${pad(label, labelWidth)}   ${C.dim}${cmd.blurb}${C.reset}`);
  }
  lines.push('');
  lines.push(
    `  ${C.dim}Run${C.reset} ${C.cyan}kortix <subcommand> --help${C.reset} ${C.dim}for command-specific options.${C.reset}`,
  );
  lines.push('');
  return lines.join('\n');
}

function printVersion(): void {
  process.stdout.write(`${header('Kortix CLI', VERSION)}\n`);
}

async function main(argv: string[]): Promise<number> {
  for (const arg of argv) {
    if (arg === '--version' || arg === '-v') {
      printVersion();
      return 0;
    }
  }
  if (argv.length === 0) {
    // No args — show the big ASCII banner above the help, like `vercel`.
    printBanner();
    // Always surface what host/account/project commands will act on.
    process.stdout.write(`${renderContext()}\n`);
    const notice = await getUpdateNotice(VERSION, { allowFetch: true, style: 'box' });
    if (notice) process.stdout.write(`${notice}\n`);
    process.stdout.write(renderHelp());
    return 0;
  }
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    const notice = await getUpdateNotice(VERSION, { allowFetch: true, style: 'box' });
    if (notice) process.stdout.write(`${notice}\n`);
    process.stdout.write(renderHelp());
    return 0;
  }
  if (argv[0] === 'version') {
    printVersion();
    const notice = await getUpdateNotice(VERSION, { allowFetch: true, style: 'box' });
    if (notice) process.stdout.write(`${notice}\n`);
    return 0;
  }
  // `executor` is a MACHINE surface (the in-sandbox agent parses stdout as JSON,
  // and `executor mcp` speaks JSON-RPC on stdout). Skip the human-oriented host
  // + update notices so its output stays clean.
  if (argv[0] !== 'executor') {
    printActiveHostNotice(argv);
    await printUpdateNoticeForCommand(argv[0]);
  }
  if (argv[0] === 'init') {
    return runInit(argv.slice(1));
  }
  // `deploy` is kept as a familiar alias for `ship`.
  if (argv[0] === 'ship' || argv[0] === 'deploy') {
    return runShip(argv.slice(1));
  }
  if (argv[0] === 'validate') {
    return runValidate(argv.slice(1));
  }
  if (argv[0] === 'dev') {
    return runDev(argv.slice(1));
  }
  if (argv[0] === 'login') {
    return runLogin(argv.slice(1));
  }
  if (argv[0] === 'logout') {
    return runLogout(argv.slice(1));
  }
  if (argv[0] === 'whoami') {
    return runWhoami(argv.slice(1));
  }
  if (argv[0] === 'token') {
    return runWhoami(['--token-only', ...argv.slice(1)]);
  }
  if (argv[0] === 'projects') {
    return runProjects(argv.slice(1));
  }
  if (argv[0] === 'hosts') {
    return runHosts(argv.slice(1));
  }
  if (argv[0] === 'accounts') {
    return runAccounts(argv.slice(1));
  }
  if (argv[0] === 'secrets') {
    return runSecrets(argv.slice(1));
  }
  if (argv[0] === 'self-host') {
    return runSelfHost(argv.slice(1));
  }
  if (argv[0] === 'env') {
    return runEnv(argv.slice(1));
  }
  if (argv[0] === 'sessions') {
    return runSessions(argv.slice(1));
  }
  if (argv[0] === 'chat') {
    return runSessionsChat(argv.slice(1));
  }
  if (argv[0] === 'files') {
    return runFiles(argv.slice(1));
  }
  if (argv[0] === 'triggers') {
    return runTriggers(argv.slice(1));
  }
  if (argv[0] === 'tunnel') {
    return runTunnel(argv.slice(1));
  }
  if (argv[0] === 'channels') {
    return runChannels(argv.slice(1));
  }
  if (argv[0] === 'connectors') {
    return runConnectors(argv.slice(1));
  }
  if (argv[0] === 'executor') {
    return runExecutor(argv.slice(1));
  }
  if (argv[0] === 'marketplace') {
    return runMarketplace(argv.slice(1));
  }
  if (argv[0] === 'registry') {
    process.stderr.write(`${C.yellow}developer command:${C.reset} registry is an internal marketplace authoring format; use ${C.cyan}kortix marketplace${C.reset} for normal install/search.\n`);
    return runRegistry(argv.slice(1));
  }
  if (argv[0] === 'sandboxes') {
    return runSandboxes(argv.slice(1));
  }
  if (argv[0] === 'apps') {
    return runApps(argv.slice(1));
  }
  if (argv[0] === 'cr') {
    return runCr(argv.slice(1));
  }
  if (argv[0] === 'access') {
    return runAccess(argv.slice(1));
  }
  if (argv[0] === 'roles') {
    return runRoles(argv.slice(1));
  }
  if (argv[0] === 'update') {
    return runUpdate(argv.slice(1));
  }
  if (argv[0] === 'uninstall') {
    return runUninstall(argv.slice(1));
  }
  // Reserved subcommand names we don't ship yet — don't let them fall
  // through to the project scaffold (`kortix <new-project-name>`), which
  // would otherwise create a directory called `deploy/`, etc.
  const RESERVED_FUTURE_COMMANDS = new Set([
    'add',
    'mcp',
    'logs',
    'start',
    'stop',
    'restart',
    'open',
    'status',
  ]);
  if (RESERVED_FUTURE_COMMANDS.has(argv[0])) {
    process.stderr.write(
      `${C.red}kortix:${C.reset} \`${argv[0]}\` is not a kortix subcommand (yet).\n` +
        `       Run ${C.cyan}kortix --help${C.reset} for the full list.\n`,
    );
    return 2;
  }

  // Anything else is the "create new directory" form (`kortix my-new-project`).
  return runCreate(argv);
}

function printActiveHostNotice(argv: readonly string[]): void {
  const notice = renderHostNotice(argv);
  if (notice) process.stderr.write(notice);
}

// Passive, cache-only nudge for subcommands (never touches the network, so it
// adds no latency). The prominent box only shows on the bare landing screen.
// `update`/`uninstall` skip it — they're about the binary itself.
async function printUpdateNoticeForCommand(command: string): Promise<void> {
  if (command === 'update' || command === 'uninstall') return;
  const notice = await getUpdateNotice(VERSION, { allowFetch: false, style: 'line' });
  if (notice) process.stderr.write(`${notice}\n`);
}

// `process.exit()` does NOT wait for a piped stdout/stderr to flush — on large
// output (e.g. `kortix projects ls --all --json | jq`, or executor JSON the
// in-sandbox agent parses) it drops everything past the ~64KiB pipe buffer,
// producing truncated/invalid output. Instead set the exit code and let the
// runtime flush both streams and exit naturally. Release stdin first so an
// interactive raw-mode read (tui-select / prompts) can't keep the event loop
// alive after the command is done.
function finish(code: number): void {
  process.exitCode = code;
  try {
    process.stdin.pause();
    (process.stdin as unknown as { unref?: () => void }).unref?.();
  } catch {
    /* stdin may not support pause/unref in every environment */
  }
}

main(process.argv.slice(2))
  .then((code) => finish(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${C.red}kortix:${C.reset} ${msg}\n`);
    finish(1);
  });
