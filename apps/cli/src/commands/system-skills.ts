/**
 * `kortix system-skills <subcommand>` — the Kortix SYSTEM skills, served live.
 *
 * This is the command that makes the CLI self-sufficient in ANY harness — Claude
 * Code, Codex, OpenCode. The binary plus a token is enough to learn the whole
 * platform: no repo checkout, no baked image, no local clone. `list` names every
 * system skill, `get` prints one in full, and both read `/v1/skills` on the host
 * you are actually signed into, so the instructions always match the deployment.
 *
 *   kortix system-skills                 list the system skills (how Kortix works)
 *   kortix system-skills get <name>      print one skill's SKILL.md + its file list
 *   kortix system-skills get <n> --full  …and inline every reference file
 *   kortix system-skills file <n> <path> print ONE reference file
 *   kortix system-skills path [name]     locate the on-disk skill dir
 *
 * SCOPE — system skills only, always. The command used to be `kortix skills` with
 * an `--all` flag that folded the browsable marketplace catalog into the same
 * list, which made "what does this command return?" depend on a flag. It now
 * returns exactly one thing: the kortix-managed floor that describes how Kortix
 * works. Optional/marketplace skills were never lost — they are the marketplace's
 * job and stay reachable at their proper home:
 *
 *   kortix marketplace list --type skill
 *
 * which is the identical query `--all` issued (`/marketplace/items?type=skill`),
 * with richer output. Nothing was deleted; one surface stopped doing two jobs.
 *
 * `kortix skills` REMAINS a working alias, permanently and without a deprecation
 * nag. Every already-baked sandbox image carries a seeded `kortix-system` skill
 * whose `<live-skills>` pointer says `kortix skills get <name>`, and those images
 * pin the CLI they were baked with. Dropping the old name would break exactly the
 * surface this command exists to serve. Output is written in terms of whichever
 * name you invoked, so either entry point teaches a self-consistent set of
 * commands.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Auth, loadAuth, loadAuthForHost } from '../api/auth.ts';
import { type ApiClient, ApiError, clientFromAuth } from '../api/client.ts';
import { emitJson, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

/** One entry of `GET /v1/skills` — cheap by design: no body, no file contents. */
interface SkillSummary {
  name: string;
  description: string;
  referenceCount?: number;
  bytes?: number;
}

interface SkillReference {
  path: string;
  bytes?: number;
  content?: string;
}

/** `GET /v1/skills/:name` — the complete markdown the agent is meant to follow. */
interface SkillDetail {
  name: string;
  description: string;
  body: string;
  references: SkillReference[];
}

interface SkillsListResponse {
  skills: SkillSummary[];
  count: number;
}

interface SkillsFlags {
  host?: string;
  all: boolean;
  full: boolean;
  json: boolean;
}

/** The canonical command name; `skills` is kept as an alias (see file header). */
export const SYSTEM_SKILLS_COMMAND = 'system-skills';

const helpFor = (cmd: string) => help`Usage: kortix ${cmd} <subcommand> [options]

Learn how to drive Kortix. The Kortix system skills are the platform's own
documentation — sessions, sandboxes, the executor/approval loop, memory,
channels — served live by the host you are signed into, so they always match
the version you are talking to. This is all any harness needs: the binary,
a token, and these skills.

Subcommands:
  list                 List the Kortix system skills (default).
  get <name>           Print one skill's current SKILL.md body, then list the
                       paths of its reference files.
  file <name> <path>   Print ONE reference file. Cheaper than --full when you
                       only need a single document.
  path [name]          Print the on-disk skill directory.

Options:
  --full               get: also inline every referenced file (kortix-system is
                       ~230 KB in full — prefer \`file\` for a single document).
  --host <name>        Use a configured Kortix host.
  --json               Machine-readable output.
  -h, --help           Show this help.

Examples:
  kortix ${cmd}
  kortix ${cmd} get kortix-system
  kortix ${cmd} file kortix-system references/kortix/kortix-yaml.md
  kortix ${cmd} get kortix-slack --json

Optional (non-system) skills live in the marketplace:
  kortix marketplace list --type skill
`;

/** Where a skill's files live inside a Kortix project. */
const SKILLS_DIR = '.kortix/opencode/skills';

function parseFlags(argv: string[]): SkillsFlags {
  return {
    host: takeFlagValue(argv, ['--host']),
    all: takeFlagBool(argv, ['--all']),
    full: takeFlagBool(argv, ['--full']),
    json: takeFlagBool(argv, ['--json']),
  };
}

function resolveClient(host?: string): { client: ApiClient; auth: Auth } | null {
  const auth = host ? loadAuthForHost(host) : loadAuth();
  if (!auth?.token) {
    if (host) {
      process.stderr.write(
        `${status.err(`Host "${host}" is not logged in.`)} Run ${C.cyan}kortix login --host ${host}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    }
    return null;
  }
  return { client: clientFromAuth(auth), auth };
}

/** The system floor — the kortix-managed skills that describe how Kortix works. */
async function fetchSystemSkills(client: ApiClient): Promise<SkillSummary[]> {
  const res = await client.get<SkillsListResponse>('/skills');
  return res.skills ?? [];
}

/** `--all` used to mix the marketplace catalog into this list. It no longer does
 *  anything, and a silently-different result for an old invocation is worse than
 *  a one-line redirect — say where those skills went. Skipped under --json: a
 *  parser deserves a clean run with nothing on either channel it must ignore. */
function noteAllFlagMoved(flags: SkillsFlags): void {
  if (!flags.all || flags.json) return;
  process.stderr.write(
    `${C.dim}--all no longer applies: this lists system skills only. Optional skills:${C.reset} ${C.cyan}kortix marketplace list --type skill${C.reset}\n`,
  );
}

async function skillsList(flags: SkillsFlags, cmd: string): Promise<number> {
  const ctx = resolveClient(flags.host);
  if (!ctx) return 1;

  let skills: SkillSummary[];
  try {
    skills = await fetchSystemSkills(ctx.client);
  } catch (err) {
    // A 404 on the LIST route is never "no skills" — the route itself is
    // missing, i.e. the host predates `/v1/skills`. Say that, or an agent burns
    // turns retrying a bare "Not found".
    if (err instanceof ApiError && err.status === 404) {
      process.stderr.write(
        `${status.err('This Kortix host does not serve system skills yet.')} It needs a newer API; check ${C.cyan}kortix whoami${C.reset} for which host you are on.\n`,
      );
      return 1;
    }
    return surfaceApiError(err);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  if (flags.json) {
    emitJson({ skills, count: skills.length });
    return 0;
  }
  noteAllFlagMoved(flags);
  if (skills.length === 0) {
    process.stdout.write(`${status.info('No system skills found.')}\n`);
    return 0;
  }
  process.stdout.write(
    `\n  ${C.bold}Kortix system skills${C.reset} ${C.faded}(live — how Kortix works)${C.reset}\n\n`,
  );
  const width = Math.min(24, Math.max(...skills.map((s) => s.name.length)));
  for (const s of skills) {
    process.stdout.write(
      `  ${C.cyan}${s.name.padEnd(width)}${C.reset}  ${summarize(s.description)}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}Load one:${C.reset} ${C.cyan}kortix ${cmd} get <name>${C.reset}\n`,
  );
  return 0;
}

/** Skill descriptions are agent-facing routing triggers and run to a paragraph.
 *  The human-readable list shows the first sentence; `--json` keeps them whole. */
function summarize(description: string): string {
  const first = (description ?? '').split(/(?<=\.)\s/)[0] ?? '';
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

async function skillsGet(argv: string[], flags: SkillsFlags, cmd: string): Promise<number> {
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) {
    process.stderr.write(`${status.err(`pass a skill name: kortix ${cmd} get kortix-system`)}\n`);
    return 2;
  }
  const ctx = resolveClient(flags.host);
  if (!ctx) return 1;

  // `--full` asks the API to inline every reference file in the same response —
  // one round trip instead of N, and the server already holds them in memory.
  const path = `/skills/${encodeURIComponent(name)}${flags.full ? '?full=1' : ''}`;
  let detail: SkillDetail;
  try {
    detail = await ctx.client.get<SkillDetail>(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      process.stderr.write(
        `${status.err(`No Kortix system skill matches "${name}".`)} Run ${C.cyan}kortix ${cmd}${C.reset}.\n`,
      );
      return 1;
    }
    return surfaceApiError(err);
  }

  const references = detail.references ?? [];

  if (flags.json) {
    emitJson({
      name: detail.name,
      description: detail.description,
      body: detail.body,
      files: flags.full
        ? references.map((f) => ({ target: f.path, content: f.content ?? '' }))
        : references.map((f) => f.path),
    });
    return 0;
  }

  // Raw markdown to stdout — this is what the agent reads.
  process.stdout.write(detail.body.endsWith('\n') ? detail.body : `${detail.body}\n`);
  if (flags.full) {
    for (const f of references) {
      if (f.content == null) continue;
      process.stdout.write(`\n\n===== ${f.path} =====\n\n`);
      process.stdout.write(f.content.endsWith('\n') ? f.content : `${f.content}\n`);
    }
  } else if (references.length > 0) {
    // List the PATHS, not just a count. These are the argument to
    // `file <name> <path>`, so a bare `get` has to name them or the cheap
    // single-file fetch is undiscoverable and every reader is pushed to --full.
    process.stderr.write(
      `\n${C.dim}${references.length} referenced file${references.length === 1 ? '' : 's'} not shown:${C.reset}\n`,
    );
    for (const f of references) {
      process.stderr.write(`  ${C.dim}${f.path}${C.reset}\n`);
    }
    process.stderr.write(
      `\n${C.dim}Read one with ${C.reset}${C.cyan}kortix ${cmd} file ${detail.name} <path>${C.reset}${C.dim}, or add ${C.reset}${C.cyan}--full${C.reset}${C.dim} to inline them all.${C.reset}\n`,
    );
  }
  return 0;
}

/**
 * `get <name> <path>` — ONE reference file, not the whole tree.
 *
 * `get --full` inlines every reference in a single response, which for
 * `kortix-system` is ~230 KB. An agent that needs one file (say
 * `references/kortix/kortix-yaml.md`, ~8 KB) should not have to spend the other
 * 222 KB of its context to read it. This fronts the API's existing
 * `GET /skills/:name/file?path=…`, which was reachable over HTTP but had no CLI
 * surface at all, making the CLI all-or-nothing.
 *
 * Discovery is the plain `get`: it lists every reference path, then you fetch
 * the one you want by name.
 */
async function skillsFile(argv: string[], flags: SkillsFlags, cmd: string): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const [name, path] = positional;
  if (!name || !path) {
    process.stderr.write(
      `${status.err('pass a skill and a file path')}: ${C.cyan}kortix ${cmd} file kortix-system references/kortix/kortix-yaml.md${C.reset}\n`,
    );
    return 2;
  }
  const ctx = resolveClient(flags.host);
  if (!ctx) return 1;

  const url = `/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`;
  let file: { name: string; path: string; content: string };
  try {
    file = await ctx.client.get<{ name: string; path: string; content: string }>(url);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // Distinguish "no such skill" from "no such file in it" — the second is
      // the common typo, and the fix is to list the paths, not the skills.
      process.stderr.write(
        `${status.err(`No file "${path}" in Kortix system skill "${name}".`)} List its files with ${C.cyan}kortix ${cmd} get ${name}${C.reset}.\n`,
      );
      return 1;
    }
    return surfaceApiError(err);
  }

  if (flags.json) {
    emitJson({ name: file.name, path: file.path, content: file.content });
    return 0;
  }
  process.stdout.write(file.content.endsWith('\n') ? file.content : `${file.content}\n`);
  return 0;
}

/** Walk up from cwd to a Kortix project root, else use cwd. Keys on a project
 *  marker (a `kortix.yaml`/`kortix.toml` manifest or a `.kortix/opencode` dir),
 *  not a bare `.kortix/` — otherwise the CLI's own `~/.kortix` home dir matches. */
function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (
      existsSync(join(dir, 'kortix.yaml')) ||
      existsSync(join(dir, 'kortix.toml')) ||
      existsSync(join(dir, '.kortix', 'opencode'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function skillsPath(argv: string[], flags: SkillsFlags): number {
  const name = argv.find((a) => !a.startsWith('-'));
  const base = join(projectRoot(), SKILLS_DIR);
  const target = name ? join(base, name) : base;
  if (flags.json) {
    emitJson({ path: target, exists: existsSync(target) });
    return 0;
  }
  process.stdout.write(`${target}\n`);
  return 0;
}

/** `invokedAs` is the name the user actually typed (`system-skills`, or the
 *  `skills` alias). Every hint we print uses it, so a session never learns a
 *  command spelling that differs from the one that got it here. */
export async function runSystemSkills(
  argv: string[],
  invokedAs: string = SYSTEM_SKILLS_COMMAND,
): Promise<number> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(helpFor(invokedAs));
    return 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  // Bare `kortix system-skills`, `list`/`ls`, or a leading flag
  // (`kortix system-skills --json`) all list the system floor. A leading flag
  // isn't a subcommand, so its flags come from the whole argv.
  if (!sub || sub === 'list' || sub === 'ls' || sub.startsWith('-')) {
    return skillsList(parseFlags(sub && sub.startsWith('-') ? argv.slice() : rest), invokedAs);
  }
  switch (sub) {
    case 'get':
    case 'show':
    case 'cat':
      return skillsGet(rest, parseFlags(rest), invokedAs);
    case 'file':
    case 'ref':
      return skillsFile(rest, parseFlags(rest), invokedAs);
    case 'path':
    case 'where':
      return skillsPath(rest, parseFlags(rest));
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${helpFor(invokedAs)}`);
      return 2;
  }
}
