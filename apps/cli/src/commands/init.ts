import { existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LEGACY_OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_DIR } from '@kortix/manifest-schema/layout';
import {
  DEFAULT_STARTER_TEMPLATE_ID,
  STARTER_TEMPLATE_IDS,
  type StarterTemplateId,
} from '@kortix/starter';

import { applyScaffold } from '../scaffold.ts';
import { prompt, confirm } from '../prompts.ts';
import { selectMultiFromList } from '../tui-select.ts';
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import {
  wireCodingAgents,
  SUPPORTED_AGENTS,
  DEFAULT_PRIMARY,
  type CodingAgent,
} from '../agents.ts';
import { printBanner, printGetStarted } from '../banner.ts';
import { C, help, status } from '../style.ts';
import { appendGitExcludeEntries } from '../git-exclude.ts';

function agentSublabel(agent: CodingAgent): string {
  switch (agent) {
    case 'opencode':
      return 'symlink .opencode → harnesses/opencode, .agents/skills → skills';
    case 'claude':
      return 'link .claude skills, agents, and commands';
    case 'codex':
      return 'symlink .agents/skills → skills + AGENTS.md';
    case 'pi':
      return 'link .pi/skills + AGENTS.md';
    case 'cursor':
      return 'AGENTS.md (read natively — no rule file)';
    default:
      return '';
  }
}

const HELP = help`Usage: kortix init [project-name] [options]

Start a new Kortix project.

A fresh, self-contained workspace your agents can run from day one — the
Kortix project floor, project memory, and a kortix.yaml to make it yours.
By default this works like create-next-app and creates a new directory. In an
already-cloned Kortix repository, pass --force to wire local coding agents in
place without replacing repository files.

Arguments:
  project-name         Your project's name — and the directory it's created
                       in. Prompted if omitted.

Pick the local coding tools to wire up. The starter's canonical skill source is
linked into each native discovery location. Local tool files remain in
.claude, .codex, and .pi.
Codex, Pi, and Cursor also get a root AGENTS.md pointer.

This local tool selection does not change the cloud OpenCode REST runtime.

Options:
  --name <project>     Alias for the positional project-name.
  --primary <agent>    Primary coding agent to wire up (${SUPPORTED_AGENTS.join('|')}).
  --agents <list>      Comma-separated extras to wire up alongside --primary.
                       Example: --agents claude,cursor
  --force              Configure the current cloned Kortix repository in place.
                       Requires kortix.yaml (or kortix.toml) and an OpenCode
                       config dir (harnesses/opencode, or .kortix/opencode).
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
}

const isCodingAgent = (value: string): value is CodingAgent =>
  SUPPORTED_AGENTS.some((agent) => agent === value);

const isStarterTemplate = (value: string): value is StarterTemplateId =>
  STARTER_TEMPLATE_IDS.some((id) => id === value);

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

/** Keep post-clone agent wiring local so setup never dirties the user's repo. */
function excludeLocalAgentWiring(repoRoot: string): void {
  appendGitExcludeEntries(
    repoRoot,
    ['/.agents', '/.claude', '/.opencode', '/.pi', '/AGENTS.md'],
    'Kortix local coding-agent wiring',
  );
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
    `  Pick the local coding tools to wire into this Kortix project.`,
    '',
    `  ${dim}Each tool receives the starter's canonical Kortix system skills.${reset}`,
    `  ${dim}Ask it to configure triggers, agents, or OpenCode settings.${reset}`,
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
  const flags = takeFlags(argv, HELP, (rest) => {
    let primary: CodingAgent | undefined;
    const primaryValue = takeFlagValue(rest, ['--primary']);
    if (primaryValue !== undefined) {
      if (!isCodingAgent(primaryValue)) {
        throw new Error(`--primary must be one of ${SUPPORTED_AGENTS.join(', ')}`);
      }
      primary = primaryValue;
    }
    let agents: CodingAgent[] | undefined;
    const agentsValue = takeFlagValue(rest, ['--agents']);
    if (agentsValue !== undefined) {
      const list: CodingAgent[] = [];
      for (const part of agentsValue.split(',')) {
        const norm = part.trim().toLowerCase();
        if (!norm) continue;
        if (!isCodingAgent(norm)) throw new Error(`unknown coding agent "${norm}"`);
        list.push(norm);
      }
      agents = list;
    }
    let template: StarterTemplateId | undefined;
    const templateValue = takeFlagValue(rest, ['--template']);
    if (templateValue !== undefined) {
      if (!isStarterTemplate(templateValue)) {
        throw new Error(`--template must be one of ${STARTER_TEMPLATE_IDS.join(', ')}`);
      }
      template = templateValue;
    }
    const flags: InitFlags = {
      name: takeFlagValue(rest, ['--name']),
      primary,
      agents,
      template,
      force: takeFlagBool(rest, ['--force']),
      overwrite: takeFlagBool(rest, ['--overwrite']),
      noGit: takeFlagBool(rest, ['--no-git']),
      yes: takeFlagBool(rest, ['-y', '--yes']),
    };
    // Positional project name (the directory to create), like create-next-app.
    const positionalIdx = rest.findIndex((arg) => !arg.startsWith('-'));
    if (positionalIdx !== -1) {
      const [positional] = rest.splice(positionalIdx, 1);
      if (flags.name !== undefined) throw new Error(`unexpected extra argument "${positional}"`);
      flags.name = positional;
    }
    return flags;
  });
  if (typeof flags === 'number') return flags;

  printBanner();

  // The default is a NEW standalone project. `--force` with no name is the
  // documented post-clone setup path and operates on cwd in place.
  return flags.force && !flags.name ? initExistingProject(flags) : initNewProject(flags);
}

/** The default path: create a standalone project directory next to the cwd. */
async function initNewProject(flags: InitFlags): Promise<number> {
  // ── Resolve project name ─────────────────────────────────────────────
  let projectName: string;
  if (flags.name) {
    projectName = normalizeProjectName(flags.name);
  } else if (flags.yes) {
    process.stderr.write(`kortix init: a project name is required — e.g. \`kortix init my-app\`.\n`);
    return 2;
  } else {
    projectName = normalizeProjectName(await prompt(`Project name`, 'my-kortix-project'));
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
  // One public starter exists. Keep parsing historical template values for
  // scripts and API compatibility. Do not expose them as product choices.
  const template = flags.template ?? DEFAULT_STARTER_TEMPLATE_ID;

  // ── Resolve coding agents (multi-select TUI) ─────────────────────────
  // One picker, space toggles, Enter confirms. First toggled is the
  // "primary" used in the get-started panel. Headless when any agent flag
  // (or -y) is present: honor --primary + --agents.
  let chosenAgents: CodingAgent[];
  if (flags.primary || flags.agents || flags.yes) {
    const primary = flags.primary ?? DEFAULT_PRIMARY;
    chosenAgents = [primary, ...(flags.agents ?? []).filter((a) => a !== primary)];
  } else {
    const picked = await pickAgents();
    if (!picked) return 1;
    chosenAgents = picked;
  }

  // ── Detect existing Kortix files ─────────────────────────────────────
  let overwrite = flags.overwrite;
  if (
    ['kortix.yaml', 'kortix.toml', '.kortix'].some((path) => existsSync(resolve(cwd, path))) &&
    !overwrite &&
    !flags.yes
  ) {
    const reuse = await confirm(
      `Detected existing Kortix files. Keep your files and only add what's missing?`,
      true,
    );
    if (!reuse) {
      const ok = await confirm(`Overwrite existing Kortix files?`, false);
      if (ok) overwrite = true;
    }
  }

  // ── Scaffold, then wire the chosen coding agents ─────────────────────
  // Link the canonical skill source into each local tool's discovery path.
  const result = applyScaffold({
    repoRoot: cwd,
    projectName,
    template,
    preserveExisting: !overwrite,
  });
  const agentInstall = wireCodingAgents({ repoRoot: cwd, agents: chosenAgents, overwrite });

  return wireAndReport({
    cwd,
    projectName,
    noGit: flags.noGit,
    written: [...result.written, ...agentInstall.written],
    skipped: [...result.skipped, ...agentInstall.skipped],
    headline: `Initialized Kortix project "${projectName}" in ${cwd}`,
    nextStep: true,
  });
}

/** The `--force` post-clone path: wire the cloned Kortix repo in place. */
function initExistingProject(flags: InitFlags): number {
  const projectName = normalizeProjectName(basename(process.cwd()));
  const cwd = resolve(process.cwd());

  const hasManifest =
    existsSync(resolve(cwd, 'kortix.yaml')) || existsSync(resolve(cwd, 'kortix.toml'));
  const hasRuntime = [OPENCODE_CONFIG_DIR, LEGACY_OPENCODE_CONFIG_DIR].some((dir) =>
    existsSync(resolve(cwd, dir)),
  );
  if (!hasManifest || !hasRuntime) {
    process.stderr.write(
      "kortix init --force: this directory is not a cloned Kortix project.\n" +
        "Expected kortix.yaml (or kortix.toml) and harnesses/opencode (or .kortix/opencode).\n",
    );
    return 1;
  }

  // ── Resolve coding agents (headless) ─────────────────────────────────
  // The post-clone run wires every supported agent unless the flags say
  // otherwise. First chosen is the "primary" used in the get-started panel.
  const primary = flags.primary ?? DEFAULT_PRIMARY;
  const requested = !flags.primary && !flags.agents ? [...SUPPORTED_AGENTS] : (flags.agents ?? []);
  const chosenAgents = [primary, ...requested.filter((a) => a !== primary)];

  // ── Wire the chosen coding agents, keeping the repo clean ────────────
  // Link the canonical skill source into each local tool's discovery path.
  const agentInstall = wireCodingAgents({ repoRoot: cwd, agents: chosenAgents, overwrite: true });
  excludeLocalAgentWiring(cwd);

  return wireAndReport({
    cwd,
    projectName,
    noGit: flags.noGit,
    written: agentInstall.written,
    skipped: agentInstall.skipped,
    headline: `Configured this Kortix project in ${cwd}`,
    nextStep: false,
  });
}

/** The interactive coding-agent multi-select. Null = nothing selected. */
async function pickAgents(): Promise<CodingAgent[] | null> {
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
    return null;
  }
  return picked;
}

/** The tail both init paths share: the optional `git init`, then the report
 *  and the get-started panel. */
function wireAndReport(args: {
  cwd: string;
  projectName: string;
  noGit: boolean;
  written: string[];
  skipped: string[];
  /** First report line — differs between the two init paths. */
  headline: string;
  /** The new-project path ends with the `cd <name>` hint. */
  nextStep: boolean;
}): number {
  const { cwd, projectName, noGit, written, skipped, headline, nextStep } = args;

  // ── Optional `git init` ──────────────────────────────────────────────
  let gitNote = '';
  if (!noGit && !dirIsGitRepo(cwd) && gitAvailable()) {
    const r = spawnSync('git', ['init', '-b', 'main'], { cwd, encoding: 'utf8' });
    gitNote = r.status === 0 ? 'Git: initialized (main)' : `Git: init failed — ${r.stderr.trim()}`;
  } else if (noGit) {
    gitNote = 'Git: skipped (--no-git)';
  } else if (dirIsGitRepo(cwd)) {
    gitNote = 'Git: existing repo (left alone)';
  }

  // ── Report ───────────────────────────────────────────────────────────
  const lines: string[] = [headline];
  lines.push(`Wrote ${written.length} file${written.length === 1 ? '' : 's'}:`);
  for (const f of written) lines.push(`  + ${f}`);
  if (skipped.length > 0) {
    lines.push(
      `Preserved ${skipped.length} existing file${skipped.length === 1 ? '' : 's'} (pass --overwrite to replace):`,
    );
    for (const f of skipped) lines.push(`  · ${f}`);
  }
  if (gitNote) lines.push(gitNote);
  if (nextStep) {
    lines.push('');
    lines.push('Next:');
    lines.push(`  cd ${projectName}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  // ── Get started panel ────────────────────────────────────────────────
  printGetStarted({
    prompt: sampleStarterPrompt(),
  });

  return 0;
}
