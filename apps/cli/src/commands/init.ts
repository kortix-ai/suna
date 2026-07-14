import { existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_STARTER_TEMPLATE_ID,
  STARTER_TEMPLATE_IDS,
  type StarterTemplateId,
} from '@kortix/starter';

import { applyScaffold } from '../scaffold.ts';
import { prompt, confirm } from '../prompts.ts';
import { selectMultiFromList } from '../tui-select.ts';
import {
  wireCodingAgents,
  SUPPORTED_AGENTS,
  DEFAULT_PRIMARY,
  type CodingAgent,
} from '../agents.ts';
import { printBanner, printGetStarted } from '../banner.ts';
import { C, help, status } from '../style.ts';

function agentSublabel(agent: CodingAgent): string {
  switch (agent) {
    case 'opencode':
      return 'OpenCode harness compatibility: .opencode → .kortix/opencode';
    case 'claude':
      return 'Claude Code local compatibility: .claude → .kortix/opencode';
    case 'codex':
      return 'Codex local compatibility: .agents → .kortix/opencode + AGENTS.md';
    case 'cursor':
      return 'AGENTS.md (read natively — no rule file)';
    default:
      return '';
  }
}

const HELP = help`Usage: kortix init [project-name] [options]

Start a new Kortix project.

A fresh, self-contained workspace your agents can run from day one — the
Kortix ACP runtime manifest, project memory, and local agent compatibility
files to make it yours.
Standalone by design: like create-next-app, init always spins up a new
project in its own directory; it never touches an existing one.

Arguments:
  project-name         Your project's name — and the directory it's created
                       in. Prompted if omitted.

Pick the local coding agent(s) to wire up for editing the project. This is
local compatibility wiring only: Kortix cloud sessions use the v3 \`runtimes\`
profiles in kortix.yaml and launch the selected ACP harness. Codex and Cursor
also get a root AGENTS.md pointer they read natively.

Options:
  --name <project>     Alias for the positional project-name.
  --primary <agent>    Primary coding agent to wire up (${SUPPORTED_AGENTS.join('|')}).
  --agents <list>      Comma-separated extras to wire up alongside --primary.
                       Example: --agents claude,cursor
  --template <name>    Starter template: general-knowledge-worker (default, full
                       skill kit) or minimal (base plumbing only).
  --no-git             Don't run \`git init\` in the new project directory.
  -y, --yes            Skip prompts (requires a project-name).
  -h, --help           Show this help.

Adding more marketplace items later is an agent import, not part of init:
start a session and ask the agent to bring one in.
`;

interface InitFlags {
  name?: string;
  primary?: CodingAgent;
  agents?: CodingAgent[];
  template?: StarterTemplateId;
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
      case '--template': {
        const next = argv[i + 1];
        if (!next || next.startsWith('-')) {
          throw new Error(`kortix: --template requires a value`);
        }
        if (!(STARTER_TEMPLATE_IDS as readonly string[]).includes(next)) {
          throw new Error(`kortix: --template must be one of ${STARTER_TEMPLATE_IDS.join(', ')}`);
        }
        f.template = next as StarterTemplateId;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) throw new Error(`kortix: unknown option "${arg}"`);
        // Positional project name (the directory to create), like create-next-app.
        if (f.name !== undefined) throw new Error(`kortix: unexpected extra argument "${arg}"`);
        f.name = arg;
        break;
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
    `  Pick the coding agent(s) to wire into this Kortix project.`,
    '',
    `  ${dim}This wires local editor/CLI compatibility. Cloud sessions use${reset}`,
    `  ${dim}kortix.yaml v3 runtime profiles and launch ACP harness adapters.${reset}`,
    `  ${dim}The default starter still includes an OpenCode harness profile at${reset}`,
    `  ${dim}.kortix/opencode; add Claude/Codex native config as needed.${reset}`,
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
    'or a daily digest worker), wire up the trigger in kortix.yaml, ' +
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

  printBanner();

  // ── Resolve project name ─────────────────────────────────────────────
  // `kortix init` ALWAYS creates a NEW standalone project in its own fresh
  // directory (like `create-next-app`) — it never scaffolds into an existing
  // folder. The project name IS the directory name.
  let projectName: string;
  if (flags.name) {
    projectName = normalizeProjectName(flags.name);
  } else if (flags.yes) {
    process.stderr.write(`kortix init: a project name is required — e.g. \`kortix init my-app\`.\n`);
    return 2;
  } else {
    const answer = await prompt(`Project name`, 'my-kortix-project');
    projectName = normalizeProjectName(answer);
  }

  // Create the project in a fresh directory next to the shell's cwd. Refuse to
  // scaffold into an existing non-empty folder — a Kortix project is standalone.
  const cwd = resolve(process.cwd(), projectName);
  if (existsSync(cwd) && statSync(cwd).isDirectory() && readdirSync(cwd).length > 0) {
    process.stderr.write(
      `kortix init: "${projectName}" already exists and isn't empty.\n` +
        `Pick a different name, or remove the directory first.\n`,
    );
    return 1;
  }
  mkdirSync(cwd, { recursive: true });

  // ── Resolve starter template ────────────────────────────────────────
  // There's one starter kit — every project scaffolds with the full Kortix
  // skill kit. The `--template` flag stays as an advanced escape hatch (e.g.
  // the internal base-only `minimal`), but we no longer prompt for a choice.
  const template: StarterTemplateId = flags.template ?? DEFAULT_STARTER_TEMPLATE_ID;

  // ── Resolve coding agents (multi-select TUI) ─────────────────────────
  // One picker, space toggles, Enter confirms. First toggled is the
  // "primary" used in the get-started panel. Order returned from the
  // TUI is toggle-order, so primary = chosen[0].
  let chosenAgents: CodingAgent[];

  if (flags.primary || flags.agents || flags.yes) {
    // Headless / flag-driven path. Honor --primary + --agents.
    const primary = flags.primary ?? DEFAULT_PRIMARY;
    const extras = (flags.agents ?? []).filter((a) => a !== primary);
    chosenAgents = [primary, ...extras];
  } else {
    printAgentPreamble();
    const initialIdx = SUPPORTED_AGENTS.indexOf(DEFAULT_PRIMARY);
    const picked = await selectMultiFromList<CodingAgent>({
      title: 'Pick the coding agent(s) to wire into this Kortix project',
      searchHint: `${C.dim}↑/↓ navigate · Space toggle · Enter confirm${C.reset}`,
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
    template,
    preserveExisting: !flags.overwrite,
  });

  // ── Wire up the chosen coding agents ─────────────────────────────────
  // Wire local coding-agent compatibility. This is not the cloud runtime
  // selector; cloud sessions are governed by kortix.yaml v3 runtime profiles.
  const agentInstall = wireCodingAgents({
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
  lines.push('');
  lines.push('Next:');
  lines.push(`  cd ${projectName}`);
  process.stdout.write(`${lines.join('\n')}\n`);

  // ── Get started panel ────────────────────────────────────────────────
  printGetStarted({
    prompt: sampleStarterPrompt(),
  });

  return 0;
}
