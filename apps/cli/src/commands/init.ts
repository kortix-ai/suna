import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { applyScaffold } from '../scaffold.ts';
import { prompt, confirm } from '../prompts.ts';
import { selectMultiFromList } from '../tui-select.ts';
import {
  installAgentSkills,
  SUPPORTED_AGENTS,
  DEFAULT_PRIMARY,
  type CodingAgent,
} from '../agents.ts';
import { printBanner, printGetStarted } from '../banner.ts';
import { C, status } from '../style.ts';

function agentSublabel(agent: CodingAgent): string {
  switch (agent) {
    case 'opencode':
      return 'symlink at .opencode/skills/kortix/';
    case 'claude':
      return 'symlink at .claude/skills/kortix/';
    case 'codex':
      return 'AGENTS.md pointer';
    case 'cursor':
      return '.cursor/rules/kortix.mdc pointer';
    default:
      return '';
  }
}

const HELP = `Usage: kortix init [options]

Scaffold a Kortix project in the current directory. Drops kortix.toml at
the repo root + a .kortix/ folder containing the Dockerfile and the
OpenCode runtime config dir (default agent + Kortix system skill). Then
wires the Kortix skill into whichever coding agents you pick
(${SUPPORTED_AGENTS.join(', ')}) so they can configure the project for
you.

Behavior:
  * If kortix.toml already exists, init refuses unless you pass --force.
  * Existing files are preserved by default. Pass --overwrite to clobber.
  * If the directory isn't a git repo, init runs \`git init -b main\`
    (skip with --no-git).

Options:
  --name <project>     Display name for kortix.toml. Defaults to cwd basename.
  --primary <agent>    Primary coding agent — featured in the get-started
                       panel (${SUPPORTED_AGENTS.join('|')}).
  --agents <list>      Comma-separated extras to wire up alongside --primary.
                       Example: --agents claude,cursor
  --force              Re-scaffold even if kortix.toml already exists.
  --overwrite          Overwrite existing files (default: preserve).
  --no-git             Don't run \`git init\` if the dir isn't a repo.
  -y, --yes            Skip prompts; accept all defaults (primary only).
  -h, --help           Show this help.
`;

interface InitFlags {
  name?: string;
  primary?: CodingAgent;
  agents?: CodingAgent[];
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
      case '--agents': {
        const next = argv[i + 1];
        if (!next || next.startsWith('-')) {
          throw new Error(`kortix: --agents requires a value`);
        }
        const list: CodingAgent[] = [];
        for (const part of next.split(',')) {
          const norm = part.trim().toLowerCase();
          if (!norm) continue;
          if (!(SUPPORTED_AGENTS as readonly string[]).includes(norm)) {
            throw new Error(`kortix: unknown coding agent "${norm}"`);
          }
          list.push(norm as CodingAgent);
        }
        f.agents = list;
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
    `  Pick your local coding agent to configure this Kortix project.`,
    '',
    `  ${dim}It picks up the Kortix skill — ask it to scaffold triggers,${reset}`,
    `  ${dim}custom agents, or edit kortix.toml for you.${reset}`,
    `  ${dim}(Kortix itself runs opencode inside every sandbox session.)${reset}`,
    `  ${dim}You can add more agents on the next prompt.${reset}`,
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

  // ── Resolve coding agents (multi-select TUI) ─────────────────────────
  // One picker, space toggles, Enter confirms. First toggled is the
  // "primary" used in the get-started panel. Order returned from the
  // TUI is toggle-order, so primary = chosen[0].
  let primary: CodingAgent;
  let chosenAgents: CodingAgent[];

  if (flags.primary || flags.agents || flags.yes) {
    // Headless / flag-driven path. Honor --primary + --agents.
    primary = flags.primary ?? DEFAULT_PRIMARY;
    const extras = (flags.agents ?? []).filter((a) => a !== primary);
    chosenAgents = [primary, ...extras];
  } else {
    printAgentPreamble();
    const initialIdx = SUPPORTED_AGENTS.indexOf(DEFAULT_PRIMARY);
    const picked = await selectMultiFromList<CodingAgent>({
      title: 'Pick the coding agent(s) you want the Kortix skill wired into',
      searchHint: `${C.dim}↑/↓ navigate · Space toggle · Enter confirm · first toggled = primary${C.reset}`,
      items: SUPPORTED_AGENTS.map((a) => ({
        value: a,
        label: a,
        sublabel: agentSublabel(a),
      })),
      initiallySelected: initialIdx >= 0 ? [initialIdx] : [0],
      minSelected: 1,
    });
    if (!picked || picked.length === 0) {
      process.stderr.write(`${status.err('No coding agent selected.')}\n`);
      return 1;
    }
    primary = picked[0]!;
    chosenAgents = picked;
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
