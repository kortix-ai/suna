#!/usr/bin/env bun
import { runAccess } from './commands/access.ts';
import { runApps } from './commands/apps.ts';
import { runChannels } from './commands/channels.ts';
import { runConnectors } from './commands/connectors.ts';
import { runCr } from './commands/cr.ts';
import { runCreate } from './commands/create.ts';
import { runEnv } from './commands/env.ts';
import { runFiles } from './commands/files.ts';
import { runHosts } from './commands/hosts.ts';
import { runInit } from './commands/init.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runProjects } from './commands/projects.ts';
import { runSandboxes } from './commands/sandboxes.ts';
import { runSecrets } from './commands/secrets.ts';
import { runSelfHost } from './commands/self-host.ts';
import { runSessions } from './commands/sessions.ts';
import { runSessionsChat } from './commands/sessions-chat.ts';
import { runShip } from './commands/ship.ts';
import { runTriggers } from './commands/triggers.ts';
import { runUninstall } from './commands/uninstall.ts';
import { runUpdate } from './commands/update.ts';
import { runValidate } from './commands/validate.ts';
import { runWhoami } from './commands/whoami.ts';
import { printBanner } from './banner.ts';
import { activeHostEntry } from './api/config.ts';
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
  { name: 'self-host', args: '<subcommand>', blurb: 'Run your own Kortix Cloud from Docker images' },
  { name: 'login', blurb: 'Authenticate against the Kortix cloud' },
  { name: 'logout', blurb: 'Remove the stored auth token' },
  { name: 'whoami', blurb: 'Show the currently authenticated user' },
  { name: 'hosts', args: '<subcommand>', blurb: 'Manage + switch Kortix API hosts' },
  { name: 'projects', args: '<subcommand>', blurb: 'List, link, open Kortix cloud projects' },
  { name: 'secrets', args: '<subcommand>', blurb: 'Manage project secrets (project-scoped)' },
  { name: 'env', args: '<subcommand>', blurb: 'Pull/push project secrets as a dotenv file' },
  { name: 'sessions', args: '<subcommand>', blurb: 'List, create, restart project sessions' },
  { name: 'chat', args: '[session-id]', blurb: 'Talk to a session\'s agent (REPL or --prompt)' },
  { name: 'files', args: '<subcommand>', blurb: 'Browse repo files, commits, branches, diffs' },
  { name: 'triggers', args: '<subcommand>', blurb: 'List, fire, enable/disable triggers' },
  { name: 'channels', args: '<subcommand>', blurb: 'Connect Slack to this project (status/connect/disconnect/manifest)' },
  { name: 'connectors', args: '<subcommand>', blurb: 'Manage integrations agents call as tools (Pipedream/MCP/HTTP)' },
  { name: 'sandboxes', args: '<subcommand>', blurb: 'Manage sandbox images: templates, builds, health' },
  { name: 'apps', args: '<subcommand>', blurb: 'Manage deployable apps (experimental)' },
  { name: 'cr', args: '<subcommand>', blurb: 'Open, review, merge change requests' },
  { name: 'access', args: '<subcommand>', blurb: 'Manage who can use this project (invite/grant/revoke)' },
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
    process.stdout.write(renderHelp());
    return 0;
  }
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(renderHelp());
    return 0;
  }
  if (argv[0] === 'version') {
    printVersion();
    return 0;
  }
  printActiveHostNotice(argv[0]);
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
  if (argv[0] === 'login') {
    return runLogin(argv.slice(1));
  }
  if (argv[0] === 'logout') {
    return runLogout(argv.slice(1));
  }
  if (argv[0] === 'whoami') {
    return runWhoami(argv.slice(1));
  }
  if (argv[0] === 'projects') {
    return runProjects(argv.slice(1));
  }
  if (argv[0] === 'hosts') {
    return runHosts(argv.slice(1));
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
  if (argv[0] === 'channels') {
    return runChannels(argv.slice(1));
  }
  if (argv[0] === 'connectors') {
    return runConnectors(argv.slice(1));
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
    'accounts',
    'mcp',
    'tunnel',
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

function printActiveHostNotice(command: string): void {
  if (['help', '--help', '-h', 'version'].includes(command)) return;
  const { name, host } = activeHostEntry();
  const loginState = host.token ? host.user_email || host.user_id || 'logged in' : 'not logged in';
  process.stderr.write(
    `${C.dim}host ${C.reset}${C.bold}${name}${C.reset}${C.dim} (${host.url}, ${loginState})${C.reset}\n`,
  );
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${C.red}kortix:${C.reset} ${msg}\n`);
    process.exit(1);
  });
