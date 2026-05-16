#!/usr/bin/env bun
import { runCreate } from './commands/create.ts';

const HELP = `kortix — create a new Kortix project.

Usage:
  kortix                  Prompt for a project name, then create.
  kortix <project-name>   Create a project directory with that name.
  kortix --help           Show this help.
  kortix --version        Print the CLI version.

What it does:
  1. mkdir <project-name>
  2. git init -b main
  3. write kortix.toml, CONTEXT.md, README.md, and .opencode/ (agents, commands, skills)
  4. git add . && git commit -m "chore: init kortix project"

Pass --no-commit to skip the initial commit, --no-git to skip git entirely.
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
  if (argv[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  return runCreate(argv);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`kortix: ${msg}\n`);
    process.exit(1);
  });
