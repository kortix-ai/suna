#!/usr/bin/env bun
import { runApps } from './commands/apps.ts';
import { runCreate } from './commands/create.ts';
import { runInit } from './commands/init.ts';

const HELP = `kortix — scaffold + manage Kortix projects.

Usage:
  kortix init [options]            Scaffold the current directory.
  kortix <project-name> [options]  Create a new directory and scaffold it.
  kortix apps <subcommand>         List or deploy [[apps]] from kortix.toml.
  kortix --help                    Show this help.
  kortix --version                 Print the CLI version.

Run \`kortix init --help\`, \`kortix apps --help\`, or \`kortix <name> --help\`
for command-specific options.

What 'init' does:
  Drops kortix.toml + .kortix/ (Dockerfile + OpenCode config dir with
  the default agent, the kortix-system skill, and the show tool) +
  README + .gitignore into the current directory. Then asks which
  coding agent(s) you use (opencode / claude / codex / cursor) and
  wires the canonical Kortix skill into each one's discovery path
  (symlinks for opencode + claude, AGENTS.md for codex, .cursor/rules
  for cursor) so they can configure the project for you. Preserves any
  existing files (use --overwrite to replace) and runs \`git init\` if
  the directory isn't already a repo.
`;

function printVersion(): void {
  console.log('kortix 0.1.0');
}

async function main(argv: string[]): Promise<number> {
  for (const arg of argv) {
    if (arg === '--version' || arg === '-v') {
      printVersion();
      return 0;
    }
  }
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === 'init') {
    return runInit(argv.slice(1));
  }
  if (argv[0] === 'apps') {
    return runApps(argv.slice(1));
  }
  // Anything else is the legacy "create new directory" form.
  return runCreate(argv);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`kortix: ${msg}\n`);
    process.exit(1);
  });
