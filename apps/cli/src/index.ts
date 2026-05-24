#!/usr/bin/env bun
import { runChannels } from './commands/channels.ts';
import { runCr } from './commands/cr.ts';
import { runCreate } from './commands/create.ts';
import { runEnv } from './commands/env.ts';
import { runHosts } from './commands/hosts.ts';
import { runInit } from './commands/init.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runProjects } from './commands/projects.ts';
import { runSecrets } from './commands/secrets.ts';
import { runSelfHost } from './commands/self-host.ts';
import { runSessions } from './commands/sessions.ts';
import { runShip } from './commands/ship.ts';
import { runTriggers } from './commands/triggers.ts';
import { runUninstall } from './commands/uninstall.ts';
import { runUpdate } from './commands/update.ts';
import { runWhoami } from './commands/whoami.ts';
import { printBanner } from './banner.ts';
import { C, header, pad, rule } from './style.ts';

const VERSION = '0.1.0';

interface Command {
  name: string;
  args?: string;
  blurb: string;
}

const COMMANDS: readonly Command[] = [
  { name: 'init', blurb: 'Scaffold a Kortix project in the current directory' },
  { name: '<project-name>', blurb: 'Create a new directory and scaffold it' },
  { name: 'ship', blurb: 'Create the cloud project (first run) + push your code' },
  { name: 'self-host', args: '<subcommand>', blurb: 'Run your own Kortix Cloud from Docker images' },
  { name: 'login', blurb: 'Authenticate against the Kortix cloud' },
  { name: 'logout', blurb: 'Remove the stored auth token' },
  { name: 'whoami', blurb: 'Show the currently authenticated user' },
  { name: 'hosts', args: '<subcommand>', blurb: 'Manage + switch Kortix API hosts' },
  { name: 'projects', args: '<subcommand>', blurb: 'List, link, open Kortix cloud projects' },
  { name: 'secrets', args: '<subcommand>', blurb: 'Manage project secrets (project-scoped)' },
  { name: 'env', args: '<subcommand>', blurb: 'Pull/push project secrets as a dotenv file' },
  { name: 'sessions', args: '<subcommand>', blurb: 'List, create, restart project sessions' },
  { name: 'triggers', args: '<subcommand>', blurb: 'List, fire, enable/disable triggers' },
  { name: 'channels', args: '<subcommand>', blurb: 'Connect Slack to this project (status/connect/disconnect/manifest)' },
  { name: 'cr', args: '<subcommand>', blurb: 'Open, review, merge change requests' },
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
  if (argv[0] === 'init') {
    return runInit(argv.slice(1));
  }
  // `deploy` is kept as a familiar alias for `ship`.
  if (argv[0] === 'ship' || argv[0] === 'deploy') {
    return runShip(argv.slice(1));
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
  if (argv[0] === 'triggers') {
    return runTriggers(argv.slice(1));
  }
  if (argv[0] === 'channels') {
    return runChannels(argv.slice(1));
  }
  if (argv[0] === 'cr') {
    return runCr(argv.slice(1));
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
    'apps',
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

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${C.red}kortix:${C.reset} ${msg}\n`);
    process.exit(1);
  });
