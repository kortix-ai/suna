import { existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LEGACY_OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_DIR } from '@kortix/manifest-schema/layout';
import {
  DEFAULT_STARTER_TEMPLATE_ID,
  STARTER_TEMPLATE_IDS,
  type StarterTemplateId,
} from '@kortix/starter';

import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
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
  help: boolean;
}

function parseFlags(argv: string[]): InitFlags {
  const rest = [...argv];
  const f: InitFlags = { force: false, overwrite: false, noGit: false, yes: false, help: false };
  // Help-first: `-h`/`--help` anywhere wins, wherever it sits.
  if (rest.some((a) => a === '-h' || a === '--help')) {
    f.help = true;
    for (let i = rest.length - 1; i >= 0; i -= 1) {
      if (rest[i] === '-h' || rest[i] === '--help') rest.splice(i, 1);
    }
    return f;
  }
  f.force = takeFlagBool(rest, ['--force']);
  f.overwrite = takeFlagBool(rest, ['--overwrite']);
  f.noGit = takeFlagBool(rest, ['--no-git']);
  f.yes = takeFlagBool(rest, ['-y', '--yes']);
  f.name = takeFlagValue(rest, ['--name']);
  const primary = takeFlagValue(rest, ['--primary']);
  if (primary !== undefined) {
    if (!(SUPPORTED_AGENTS as readonly string[]).includes(primary)) {
      throw new Error(`kortix: --primary must be one of ${SUPPORTED_AGENTS.join(', ')}`);
    }
    f.primary = primary as CodingAgent;
  }
  const agents = takeFlagValue(rest, ['--agents']);
  if (agents !== undefined) {
    const list: CodingAgent[] = [];
    for (const part of agents.split(',')) {
      const norm = part.trim().toLowerCase();
      if (!norm) continue;
      if (!(SUPPORTED_AGENTS as readonly string[]).includes(norm)) {
        throw new Error(`kortix: unknown coding agent "${norm}"`);
      }
      list.push(norm as CodingAgent);
    }
    f.agents = list;
  }
  const template = takeFlagValue(rest, ['--template']);
  if (template !== undefined) {
    if (!(STARTER_TEMPLATE_IDS as readonly string[]).includes(template)) {
      throw new Error(`kortix: --template must be one of ${STARTER_TEMPLATE_IDS.join(', ')}`);
    }
    f.template = template as StarterTemplateId;
  }
  // One positional: the project name (the directory to create), like
  // create-next-app. Anything else is a mistake.
  const positional = rest.filter((a) => !a.startsWith('-'));
  const unknownFlag = rest.find((a) => a.startsWith('-'));
  if (unknownFlag !== undefined) throw new Error(`kortix: unknown option "${unknownFlag}"`);
  if (positional.length > 0) {
    if (f.name === undefined) {
      f.name = positional[0];
      if (positional.length > 1) {
        throw new Error(`kortix: unexpected extra argument "${positional[1]}"`);
      }
    } else {
      throw new Error(`kortix: unexpected extra argument "${positional[0]}"`);
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

  // The mode is ONE decision: `--force` with no name is the documented
  // post-clone setup path and configures cwd in place; everything else
  // scaffolds a new project in a fresh directory.
  const configureExisting = flags.force && !flags.name;
  return configureExisting ? initExistingProject(flags) : initNewProject(flags);
}

/** `kortix init --force` — configure a CLONED Kortix project in cwd: wire the
 *  agents, exclude the local wiring from git, leave every file as-is. */
async function initExistingProject(flags: InitFlags): Promise<number> {
  const cwd = resolve(process.cwd());
  const projectName = normalizeProjectName(basename(cwd));

  const hasManifest = existsSync(resolve(cwd, 'kortix.yaml')) || existsSync(resolve(cwd, 'kortix.toml'));
  const hasRuntime = [OPENCODE_CONFIG_DIR, LEGACY_OPENCODE_CONFIG_DIR].some((dir) =>
    existsSync(resolve(cwd, dir)),
  );
  if (!hasManifest || !hasRuntime) {
    process.stderr.write(
      'kortix init --force: this directory is not a cloned Kortix project.\n' +
        'Expected kortix.yaml (or kortix.toml) and harnesses/opencode (or .kortix/opencode).\n',
    );
    return 1;
  }

  // Headless by definition: an existing project keeps every agent wired.
  const primary = flags.primary ?? DEFAULT_PRIMARY;
  const requestedAgents =
    flags.primary || flags.agents ? (flags.agents ?? []) : [...SUPPORTED_AGENTS];
  const extras = requestedAgents.filter((a) => a !== primary);
  const chosenAgents = [primary, ...extras];

  const agentInstall = wireCodingAgents({
    repoRoot: cwd,
    agents: chosenAgents,
    overwrite: true,
  });
  excludeLocalAgentWiring(cwd);

  const report = wireAndReport({
    cwd,
    flags,
    scaffold: { written: [], skipped: [] },
    agentInstall,
    headline: `Configured this Kortix project in ${cwd}`,
    nextHint: null,
  });
  printGetStarted({ prompt: sampleStarterPrompt() });
  return report;
}

/** `kortix init <name>` — scaffold a NEW standalone project next to cwd. */
async function initNewProject(flags: InitFlags): Promise<number> {
  // The default is a NEW standalone project.
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

  // One public starter exists. Keep parsing historical template values for
  // scripts and API compatibility. Do not expose them as product choices.
  const template: StarterTemplateId = flags.template ?? DEFAULT_STARTER_TEMPLATE_ID;

  // One picker, space toggles, Enter confirms. First toggled is the
  // "primary" used in the get-started panel. Order returned from the
  // TUI is toggle-order, so primary = chosen[0].
  let chosenAgents: CodingAgent[];
  if (flags.primary || flags.agents || flags.yes) {
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

  // Detected existing Kortix files: keep or overwrite (interactive only).
  const kortixExists = ['kortix.yaml', 'kortix.toml', '.kortix'].some((path) =>
    existsSync(resolve(cwd, path)),
  );
  if (kortixExists && !flags.overwrite && !flags.yes) {
    const reuse = await confirm(
      `Detected existing Kortix files. Keep your files and only add what's missing?`,
      true,
    );
    if (!reuse) {
      const ok = await confirm(`Overwrite existing Kortix files?`, false);
      if (ok) flags.overwrite = true;
    }
  }

  const scaffold = applyScaffold({
    repoRoot: cwd,
    projectName,
    template,
    preserveExisting: !flags.overwrite,
  });
  const agentInstall = wireCodingAgents({
    repoRoot: cwd,
    agents: chosenAgents,
    overwrite: flags.overwrite,
  });

  const report = wireAndReport({
    cwd,
    flags,
    scaffold,
    agentInstall,
    headline: `Initialized Kortix project "${projectName}" in ${cwd}`,
    nextHint: projectName,
  });
  printGetStarted({ prompt: sampleStarterPrompt() });
  return report;
}

/** The tail both modes share: resolve the git note, print the report and
 *  (for a new project) the next-step hint. */
function wireAndReport(opts: {
  cwd: string;
  flags: InitFlags;
  scaffold: { written: string[]; skipped: string[] };
  agentInstall: { written: string[]; skipped: string[] };
  headline: string;
  nextHint: string | null;
}): number {
  const { cwd, flags, scaffold, agentInstall, headline, nextHint } = opts;

  // Optional `git init`.
  let gitNote = '';
  if (!flags.noGit && !dirIsGitRepo(cwd) && gitAvailable()) {
    const r = spawnSync('git', ['init', '-b', 'main'], { cwd, encoding: 'utf8' });
    gitNote = r.status === 0 ? 'Git: initialized (main)' : `Git: init failed — ${r.stderr.trim()}`;
  } else if (flags.noGit) {
    gitNote = 'Git: skipped (--no-git)';
  } else {
    gitNote = 'Git: existing repo (left alone)';
  }

  const lines: string[] = [headline];
  const totalWritten = scaffold.written.length + agentInstall.written.length;
  lines.push(`Wrote ${totalWritten} file${totalWritten === 1 ? '' : 's'}:`);
  for (const f of scaffold.written) lines.push(`  + ${f}`);
  for (const f of agentInstall.written) lines.push(`  + ${f}`);

  const totalSkipped = scaffold.skipped.length + agentInstall.skipped.length;
  if (totalSkipped > 0) {
    lines.push(
      `Preserved ${totalSkipped} existing file${totalSkipped === 1 ? '' : 's'} (pass --overwrite to replace):`,
    );
    for (const f of scaffold.skipped) lines.push(`  · ${f}`);
    for (const f of agentInstall.skipped) lines.push(`  · ${f}`);
  }
  if (gitNote) lines.push(gitNote);
  if (nextHint) {
    lines.push('');
    lines.push('Next:');
    lines.push(`  cd ${nextHint}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
