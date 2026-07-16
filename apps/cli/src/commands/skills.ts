/**
 * `kortix skills <subcommand>` — load Kortix system skills straight from the
 * CLI. The `kortix-*` system skills describe how Kortix itself works
 * (sessions, sandboxes, the executor/approval loop, memory, channels). Their
 * bodies are served live from the Kortix catalog, so `get` always returns the
 * current instructions — no re-install, no image re-bake.
 *
 * This is the runtime entry path the seeded `kortix-system` skill points an
 * agent at: read the pointer, then `kortix skills get <name>` for the live body.
 *
 *   kortix skills                 list the system skills (how Kortix works)
 *   kortix skills get <name>      print one skill's current SKILL.md body
 *   kortix skills path [name]     locate the on-disk skill dir
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadAuth, loadAuthForHost, type Auth } from '../api/auth.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { emitJson, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

interface SkillItem {
  id: string;
  name: string;
  type: string;
  title: string;
  description: string | null;
  categories: string[];
  managedBy?: 'kortix';
  updatePolicy?: 'kortix-managed';
}

interface SkillDetail extends SkillItem {
  readme: string | null;
  files: Array<{ target: string; type: string }>;
}

interface CatalogResponse {
  items: SkillItem[];
}

interface SkillsFlags {
  host?: string;
  all: boolean;
  full: boolean;
  json: boolean;
}

const HELP = help`Usage: kortix skills <subcommand> [options]

Load Kortix system skills — how Kortix works — straight from the CLI.
Bodies are served live, so \`get\` always returns the current instructions.

Subcommands:
  list                 List the Kortix system skills (default).
  get <name>           Print one skill's current SKILL.md body.
  path [name]          Print the on-disk skill directory.

Options:
  --all                list: include every Kortix skill, not just the system floor.
  --full               get: also print the skill's referenced files.
  --host <name>        Use a configured Kortix host.
  --json               Machine-readable output.
  -h, --help           Show this help.

Examples:
  kortix skills
  kortix skills get kortix-system
  kortix skills get kortix-slack --json
`;

/** Skills are served from the base Kortix catalog under this source id. */
const SKILLS_SOURCE = 'kortix';
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

async function fetchSkills(client: ApiClient, query?: string): Promise<SkillItem[]> {
  const params = new URLSearchParams({ type: 'skill', source: SKILLS_SOURCE });
  if (query) params.set('query', query);
  const res = await client.get<CatalogResponse>(`/marketplace/items?${params.toString()}`);
  return res.items ?? [];
}

/** The system floor: the kortix-managed skills that describe how Kortix works. */
function isSystemSkill(item: SkillItem): boolean {
  return item.managedBy === 'kortix';
}

async function skillsList(flags: SkillsFlags): Promise<number> {
  const ctx = resolveClient(flags.host);
  if (!ctx) return 1;

  let items: SkillItem[];
  try {
    items = await fetchSkills(ctx.client);
  } catch (err) {
    return surfaceApiError(err);
  }
  const skills = (flags.all ? items : items.filter(isSystemSkill)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  if (flags.json) {
    emitJson({ skills });
    return 0;
  }
  if (skills.length === 0) {
    process.stdout.write(`${status.info('No skills found.')}\n`);
    return 0;
  }
  const heading = flags.all ? 'Kortix skills' : 'System skills — how Kortix works';
  process.stdout.write(`\n  ${C.bold}${heading}${C.reset} ${C.faded}(live, kortix-managed)${C.reset}\n\n`);
  const width = Math.min(24, Math.max(...skills.map((s) => s.name.length)));
  for (const s of skills) {
    const managed = s.managedBy === 'kortix' ? '' : ` ${C.faded}[optional]${C.reset}`;
    process.stdout.write(`  ${C.cyan}${s.name.padEnd(width)}${C.reset}  ${s.description ?? s.title}${managed}\n`);
  }
  process.stdout.write(`\n  ${C.dim}Load one:${C.reset} ${C.cyan}kortix skills get <name>${C.reset}\n`);
  return 0;
}

/** Resolve a bare skill name (e.g. `kortix-system`) to its catalog detail. Item
 *  ids are namespaced (`kortix-starter:kortix-system`), so a direct GET by name
 *  404s — search by name first, then fetch the matched id's full detail. */
async function resolveSkill(client: ApiClient, name: string): Promise<SkillDetail | null> {
  const items = await fetchSkills(client, name);
  const match =
    items.find((i) => i.name === name) ??
    items.find((i) => i.id === name) ??
    items.find((i) => i.id.endsWith(`:${name}`)) ??
    (items.length === 1 ? items[0] : null);
  if (!match) return null;
  return client.get<SkillDetail>(`/marketplace/items/${encodeURIComponent(match.id)}`);
}

async function skillsGet(argv: string[], flags: SkillsFlags): Promise<number> {
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) {
    process.stderr.write(`${status.err('pass a skill name: kortix skills get kortix-system')}\n`);
    return 2;
  }
  const ctx = resolveClient(flags.host);
  if (!ctx) return 1;

  let detail: SkillDetail | null;
  try {
    detail = await resolveSkill(ctx.client, name);
  } catch (err) {
    return surfaceApiError(err);
  }
  if (!detail) {
    process.stderr.write(`${status.err(`No Kortix skill matches "${name}".`)} Run ${C.cyan}kortix skills${C.reset}.\n`);
    return 1;
  }
  if (!detail.readme) {
    process.stderr.write(`${status.err(`Skill "${detail.name}" has no SKILL.md body available.`)}\n`);
    return 1;
  }

  const extras = (detail.files ?? []).filter((f) => !/SKILL\.md$/i.test(f.target));

  if (flags.json) {
    const files: Array<{ target: string; content: string }> = [];
    if (flags.full) {
      for (const f of extras) {
        try {
          const got = await ctx.client.get<{ target: string; content: string }>(
            `/marketplace/items/${encodeURIComponent(detail.id)}/file?path=${encodeURIComponent(f.target)}`,
          );
          if (got?.content != null) files.push(got);
        } catch {
          // best-effort — a missing reference file shouldn't fail the whole get.
        }
      }
    }
    emitJson({
      name: detail.name,
      id: detail.id,
      managedBy: detail.managedBy,
      updatePolicy: detail.updatePolicy,
      body: detail.readme,
      files: flags.full ? files : extras.map((f) => f.target),
    });
    return 0;
  }

  // Raw markdown to stdout — this is what the agent reads.
  process.stdout.write(detail.readme.endsWith('\n') ? detail.readme : `${detail.readme}\n`);
  if (flags.full) {
    for (const f of extras) {
      let content: string | null = null;
      try {
        const got = await ctx.client.get<{ target: string; content: string }>(
          `/marketplace/items/${encodeURIComponent(detail.id)}/file?path=${encodeURIComponent(f.target)}`,
        );
        content = got?.content ?? null;
      } catch {
        content = null;
      }
      if (content == null) continue;
      process.stdout.write(`\n\n===== ${f.target} =====\n\n`);
      process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    }
  } else if (extras.length > 0) {
    process.stderr.write(
      `\n${C.dim}${extras.length} referenced file${extras.length === 1 ? '' : 's'} not shown — add ${C.reset}${C.cyan}--full${C.reset}${C.dim} to include them.${C.reset}\n`,
    );
  }
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

export async function runSkills(argv: string[]): Promise<number> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  // Bare `kortix skills`, `list`/`ls`, or a leading flag (`kortix skills --json`)
  // all list the system floor. A leading flag isn't a subcommand, so its flags
  // come from the whole argv.
  if (!sub || sub === 'list' || sub === 'ls' || sub.startsWith('-')) {
    return skillsList(parseFlags(sub && sub.startsWith('-') ? argv.slice() : rest));
  }
  switch (sub) {
    case 'get':
    case 'show':
    case 'cat':
      return skillsGet(rest, parseFlags(rest));
    case 'path':
    case 'where':
      return skillsPath(rest, parseFlags(rest));
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}
