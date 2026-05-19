#!/usr/bin/env bun
import { runApps } from './commands/apps.ts';
import { runCreate } from './commands/create.ts';
import { runInit } from './commands/init.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runProjects } from './commands/projects.ts';
import { runWhoami } from './commands/whoami.ts';
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
  { name: 'login', blurb: 'Authenticate against the Kortix cloud' },
  { name: 'logout', blurb: 'Remove the stored auth token' },
  { name: 'whoami', blurb: 'Show the currently authenticated user' },
  { name: 'projects', args: '<subcommand>', blurb: 'List, link, open Kortix cloud projects' },
  { name: 'apps', args: '<subcommand>', blurb: 'List or deploy [[apps]] from kortix.toml' },
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
    `  ${C.dim}Run${C.reset} ${C.cyan}kortix init --help${C.reset} ${C.dim}or${C.reset} ${C.cyan}kortix apps --help${C.reset} ${C.dim}for command-specific options.${C.reset}`,
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
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
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
  if (argv[0] === 'apps') {
    return runApps(argv.slice(1));
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
  // Anything else is the legacy "create new directory" form.
  return runCreate(argv);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${C.red}kortix:${C.reset} ${msg}\n`);
    process.exit(1);
  });
