import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { applyScaffold } from '../scaffold.ts';
import { prompt, confirm, selectFrom } from '../prompts.ts';
import {
  installAgentSkills,
  SUPPORTED_AGENTS,
  DEFAULT_PRIMARY,
  type CodingAgent,
} from '../agents.ts';
import { printBanner, printGetStarted } from '../banner.ts';

const HELP = `Usage: kortix init [options]

Scaffold a Kortix project in the current directory. Drops kortix.toml at
the repo root + a .kortix/ folder containing the Dockerfile and the
OpenCode runtime config dir (default agent + Kortix system skill). Then
wires the Kortix skill into every supported coding agent's discovery
path (${SUPPORTED_AGENTS.join(', ')}) so any of them can configure the
project for you.

Behavior:
  * If kortix.toml already exists, init refuses unless you pass --force.
  * Existing files are preserved by default. Pass --overwrite to clobber.
  * If the directory isn't a git repo, init runs \`git init -b main\`
    (skip with --no-git).

Options:
  --name <project>     Display name for kortix.toml. Defaults to cwd basename.
  --primary <agent>    Which coding agent to feature in the get-started
                       panel (${SUPPORTED_AGENTS.join('|')}). All four
                       are always wired up regardless.
  --force              Re-scaffold even if kortix.toml already exists.
  --overwrite          Overwrite existing files (default: preserve).
  --no-git             Don't run \`git init\` if the dir isn't a repo.
  -y, --yes            Skip prompts; accept all defaults.
  -h, --help           Show this help.
`;

interface InitFlags {
  name?: string;
  primary?: CodingAgent;
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
      case '--primary': {
        const next = argv[i + 1];
        if (!next || next.startsWith('-')) {
          throw new Error(`kortix: --primary requires a value`);
        }
        if (!(SUPPORTED_AGENTS as readonly string[]).includes(next)) {
          throw new Error(`kortix: --primary must be one of ${SUPPORTED_AGENTS.join(', ')}`);
        }
        f.primary = next as CodingAgent;
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

/** Layered: bright headline up top, dim supporting text below for the
 * reader who wants the deeper context, bold options at the bottom. */
function printAgentPreamble(): void {
  const isTTY = process.stdout.isTTY === true;
  const dim = isTTY ? '\x1b[2m' : '';
  const bold = isTTY ? '\x1b[1m' : '';
  const reset = isTTY ? '\x1b[0m' : '';
  const opts = SUPPORTED_AGENTS.map((a) => `${bold}${a}${reset}`).join(`  ${dim}·${reset}  `);
  const lines = [
    '',
    `  Which coding agent do you primarily use?`,
    '',
    `  ${dim}We'll wire the Kortix skill into all four below so any of them${reset}`,
    `  ${dim}can configure this project — your pick just decides which one${reset}`,
    `  ${dim}we highlight in the get-started prompt.${reset}`,
    `  ${dim}(Kortix itself runs opencode inside every sandbox session.)${reset}`,
    '',
    `  ${opts}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** "I want a code reviewer agent. Read the kortix skill, then..." */
function sampleStarterPrompt(): string {
  return (
    'I want to configure my Kortix project. Read the kortix skill, ' +
    'then propose an initial agent for my use case (e.g. a PR reviewer ' +
    'or a daily digest worker), wire up the trigger in kortix.toml, ' +
    'and tell me what secrets I still need to set.'
  );
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

  printBanner();

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

  // ── Resolve primary coding agent ─────────────────────────────────────
  // Kortix skills are always wired into every supported agent's discovery
  // path (opencode, claude, codex, cursor) — the primary choice only
  // decides which agent gets called out in the "paste this prompt" panel.
  let primary: CodingAgent;
  if (flags.primary) {
    primary = flags.primary;
  } else if (flags.yes) {
    primary = DEFAULT_PRIMARY;
  } else {
    printAgentPreamble();
    primary = await selectFrom('Primary coding agent', SUPPORTED_AGENTS, DEFAULT_PRIMARY);
  }

  const chosenAgents: readonly CodingAgent[] = SUPPORTED_AGENTS;

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

  // ── Wire up local coding agents to the canonical skill ───────────────
  const agentInstall = installAgentSkills({
    repoRoot: cwd,
    agents: chosenAgents,
    overwrite: flags.overwrite,
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
  const totalWritten = result.written.length + agentInstall.written.length;
  lines.push(`Wrote ${totalWritten} file${totalWritten === 1 ? '' : 's'}:`);
  for (const f of result.written) lines.push(`  + ${f}`);
  for (const f of agentInstall.written) lines.push(`  + ${f}`);

  const totalSkipped = result.skipped.length + agentInstall.skipped.length;
  if (totalSkipped > 0) {
    lines.push(
      `Preserved ${totalSkipped} existing file${totalSkipped === 1 ? '' : 's'} (pass --overwrite to replace):`,
    );
    for (const f of result.skipped) lines.push(`  · ${f}`);
    for (const f of agentInstall.skipped) lines.push(`  · ${f}`);
  }
  if (gitNote) lines.push(gitNote);
  process.stdout.write(`${lines.join('\n')}\n`);

  // ── Get started panel ────────────────────────────────────────────────
  printGetStarted({
    primaryAgent: primary,
    prompt: sampleStarterPrompt(),
  });

  return 0;
}
