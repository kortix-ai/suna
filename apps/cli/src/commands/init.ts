import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { applyScaffold } from '../scaffold.ts';
import { prompt, confirm } from '../prompts.ts';

const HELP = `Usage: kortix init [options]

Scaffold a Kortix project in the current directory. Drops kortix.toml at
the repo root + a .kortix/ folder containing the Dockerfile and the
opencode config dir (kortix agent, kortix-system skill, show tool),
plus README + .gitignore.

Behavior:
  * If kortix.toml already exists, init refuses unless you pass --force.
  * Any other existing file (README.md, .kortix/<stuff>) is preserved by
    default. Pass --overwrite to clobber.
  * If the directory isn't a git repo, init runs \`git init -b main\`
    (skip with --no-git).

Options:
  --name <project>     Display name for kortix.toml. Defaults to cwd basename.
  --force              Re-scaffold even if kortix.toml already exists.
  --overwrite          Overwrite existing files (default: preserve).
  --no-git             Don't run \`git init\` if the dir isn't a repo.
  -y, --yes            Skip prompts; accept all defaults.
  -h, --help           Show this help.
`;

interface InitFlags {
  name?: string;
  force: boolean;
  overwrite: boolean;
  noGit: boolean;
  yes: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): InitFlags {
  const f: InitFlags = {
    force: false,
    overwrite: false,
    noGit: false,
    yes: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        f.help = true;
        break;
      case '--force':
        f.force = true;
        break;
      case '--overwrite':
        f.overwrite = true;
        break;
      case '--no-git':
        f.noGit = true;
        break;
      case '-y':
      case '--yes':
        f.yes = true;
        break;
      case '--name': {
        const next = argv[i + 1];
        if (!next || next.startsWith('-')) {
          throw new Error(`kortix: --name requires a value`);
        }
        f.name = next;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) throw new Error(`kortix: unknown option "${arg}"`);
        throw new Error(`kortix: unexpected argument "${arg}"`);
    }
  }
  return f;
}

function normalizeProjectName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'kortix-project';
  return trimmed.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[-\s]+|[-\s]+$/g, '') || 'kortix-project';
}

function dirIsGitRepo(path: string): boolean {
  try {
    return statSync(resolve(path, '.git')).isDirectory();
  } catch {
    return false;
  }
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

export async function runInit(argv: string[]): Promise<number> {
  let flags: InitFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const cwd = process.cwd();
  const existingManifest = existsSync(resolve(cwd, 'kortix.toml'));
  if (existingManifest && !flags.force) {
    process.stderr.write(
      `kortix init: ${cwd} already has a kortix.toml.\n` +
        `Pass --force to re-scaffold (will preserve other existing files unless --overwrite).\n`,
    );
    return 1;
  }

  // ── Resolve project name ─────────────────────────────────────────────
  let projectName: string;
  if (flags.name) {
    projectName = normalizeProjectName(flags.name);
  } else if (flags.yes) {
    projectName = normalizeProjectName(basename(cwd));
  } else {
    const defaultName = basename(cwd);
    const answer = await prompt(`Project name`, defaultName);
    projectName = normalizeProjectName(answer);
  }

  // ── Detect existing .kortix/ ─────────────────────────────────────────
  const kortixExists = existsSync(resolve(cwd, '.kortix'));
  if (kortixExists && !flags.overwrite && !flags.yes) {
    const reuse = await confirm(
      `Detected an existing .kortix/ folder. Keep your files and only add what's missing?`,
      true,
    );
    if (!reuse) {
      const ok = await confirm(`Overwrite existing Kortix files?`, false);
      if (ok) flags.overwrite = true;
    }
  }

  // ── Scaffold ─────────────────────────────────────────────────────────
  const result = applyScaffold({
    repoRoot: cwd,
    projectName,
    preserveExisting: !flags.overwrite,
  });

  // ── Optional `git init` ──────────────────────────────────────────────
  let gitNote = '';
  if (!flags.noGit && !dirIsGitRepo(cwd) && gitAvailable()) {
    const r = spawnSync('git', ['init', '-b', 'main'], { cwd, encoding: 'utf8' });
    gitNote = r.status === 0 ? 'Git: initialized (main)' : `Git: init failed — ${r.stderr.trim()}`;
  } else if (flags.noGit) {
    gitNote = 'Git: skipped (--no-git)';
  } else if (dirIsGitRepo(cwd)) {
    gitNote = 'Git: existing repo (left alone)';
  }

  // ── Report ───────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`Initialized Kortix project "${projectName}" in ${cwd}`);
  lines.push(`Wrote ${result.written.length} file${result.written.length === 1 ? '' : 's'}:`);
  for (const f of result.written) lines.push(`  + ${f}`);
  if (result.skipped.length > 0) {
    lines.push(`Preserved ${result.skipped.length} existing file${result.skipped.length === 1 ? '' : 's'} (pass --overwrite to replace):`);
    for (const f of result.skipped) lines.push(`  · ${f}`);
  }
  if (gitNote) lines.push(gitNote);
  lines.push('');
  lines.push('Next:');
  lines.push(`  edit kortix.toml                          # project manifest`);
  lines.push(`  edit .kortix/opencode/agents/kortix.md    # default agent persona`);
  lines.push(`  opencode                                  # start a local session`);
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
