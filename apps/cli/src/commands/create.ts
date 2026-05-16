import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { promptForProjectName } from '../prompts.ts';
import { applyScaffold } from '../scaffold.ts';

const HELP = `Usage: kortix [project-name] [options]

Create a new Kortix project. Makes a fresh directory next to your shell
cwd, runs \`git init -b main\` inside it, drops the OpenCode-native
scaffold at the repo root (kortix.toml + .opencode/ + CONTEXT.md +
README), stages everything, and makes an initial commit.

Arguments:
  project-name       Name of the directory to create. Prompted if omitted.

Options:
  --no-commit        Don't create the initial commit (still runs git init
                     and stages files).
  --no-git           Don't run git init at all. Useful for inspecting the
                     scaffold without making a repo.
  -h, --help         Show this help.
`;

interface ParsedFlags {
  name?: string;
  noCommit: boolean;
  noGit: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = { noCommit: false, noGit: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '--no-commit':
        flags.noCommit = true;
        break;
      case '--no-git':
        flags.noGit = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`kortix: unknown option "${arg}"`);
        }
        if (flags.name !== undefined) {
          throw new Error(`kortix: unexpected extra argument "${arg}"`);
        }
        flags.name = arg;
        break;
    }
  }
  return flags;
}

function normalizeProjectName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'kortix-project';
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'kortix-project';
}

function isEmptyDir(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function runGit(args: string[], cwd: string): { ok: boolean; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stderr: result.stderr ?? '' };
}

function gitAvailable(): boolean {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

export async function runCreate(argv: string[]): Promise<number> {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }

  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // Resolve project name: positional → prompt.
  let rawName = flags.name;
  if (rawName === undefined) {
    try {
      rawName = await promptForProjectName();
    } catch (err) {
      process.stderr.write(`kortix: ${(err as Error).message}\n`);
      return 2;
    }
  }
  const projectName = normalizeProjectName(rawName);

  const cwd = process.cwd();
  const target = isAbsolute(projectName) ? projectName : resolve(cwd, projectName);

  if (dirExists(target) && !isEmptyDir(target)) {
    process.stderr.write(
      `kortix: target directory exists and is not empty: ${target}\n` +
        `Pick a different name, or remove the directory first.\n`,
    );
    return 1;
  }

  const wantsGit = !flags.noGit;
  if (wantsGit && !gitAvailable()) {
    process.stderr.write('kortix: `git` not found on PATH. Install git, or pass --no-git.\n');
    return 1;
  }

  mkdirSync(target, { recursive: true });

  if (wantsGit) {
    const init = runGit(['init', '-b', 'main'], target);
    if (!init.ok) {
      process.stderr.write(`kortix: \`git init\` failed.\n${init.stderr}`);
      return 1;
    }
  }

  applyScaffold({ repoRoot: target, projectName });

  let madeCommit = false;
  if (wantsGit && !flags.noCommit) {
    const add = runGit(['add', '.'], target);
    if (!add.ok) {
      process.stderr.write(`kortix: \`git add\` failed.\n${add.stderr}`);
      return 1;
    }
    const commit = runGit(
      ['-c', 'commit.gpgsign=false', 'commit', '-m', 'chore: init kortix project'],
      target,
    );
    if (commit.ok) {
      madeCommit = true;
    } else {
      // Non-fatal — most often a missing git identity. Surface the
      // reason but keep the scaffold so it isn't wasted.
      process.stderr.write(
        `kortix: scaffold written but initial commit failed (continuing).\n${commit.stderr}`,
      );
    }
  }

  const lines: string[] = [
    `Scaffolded Kortix project "${projectName}" in ${target}`,
  ];
  if (wantsGit) {
    lines.push(madeCommit ? 'Git: initialized + initial commit' : 'Git: initialized (no commit)');
  } else {
    lines.push('Git: skipped (--no-git)');
  }
  lines.push('');
  lines.push(`Next:`);
  lines.push(`  cd ${projectName}`);
  if (!wantsGit) {
    lines.push('  git init -b main');
    lines.push('  git add .');
    lines.push('  git commit -m "chore: init kortix project"');
  } else if (!madeCommit) {
    lines.push('  git commit -m "chore: init kortix project"');
  }
  lines.push('  git remote add origin <your-git-url>');
  lines.push('  git push -u origin main');
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
