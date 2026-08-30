/**
 * `kortix crafts <subcommand>` — publish, browse, install and operate crafts.
 *
 * A craft is a Kortix project you install into another project: a repository
 * whose `kortix.yaml` declares agents, skills, connectors and triggers.
 *
 * Two things this command deliberately does NOT do:
 *
 *  - **It does not merge anything.** `install` starts an agent session that
 *    reads both manifests, resolves name collisions, and opens a change
 *    request. Same as `kortix marketplace install`, and for the same reason:
 *    merging into a live project is judgment, not a file copy.
 *  - **It does not upload a .zip.** Publishing from an archive exists on the
 *    web, for a folder that is not a repo yet. By the time you are at a
 *    terminal you have a repo, and a craft that tracks one gets re-crawled when
 *    it moves; an uploaded snapshot never does.
 */

import type { ApiClient } from '../api/client.ts';
import { loadAuth, loadAuthForHost, type Auth } from '../api/auth.ts';
import { clientFromAuth } from '../api/client.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

interface Craft {
  craft_id: string;
  slug: string;
  source_kind: 'github' | 'upload';
  repo: string;
  git_ref: string | null;
  resolved_sha: string | null;
  title: string;
  description: string | null;
  stars: number | null;
  install_count: number;
  visibility: 'public' | 'private';
  status: 'active' | 'unavailable' | 'yanked';
  agents: Array<{ name: string }>;
  triggers: Array<{ slug: string; cron: string | null; enabled: boolean }>;
  connectors: Array<{ slug: string; app: string | null }>;
  skills: string[];
  env_required: string[];
  last_error: string | null;
}

interface InstalledCraft {
  slug: string;
  repo: string;
  sha: string | null;
  version: string | null;
  title: string;
  installed_at: string | null;
  owns: Partial<Record<'agents' | 'skills' | 'connectors' | 'triggers', string[]>>;
}

interface CraftRun {
  execution_id: string;
  craft_slug: string;
  trigger_slug: string;
  status: string;
  created_at: string;
  session_id: string | null;
  summary: string | null;
  duration_ms: number | null;
  last_error: string | null;
}

interface CraftFlags {
  host?: string;
  project?: string;
  query?: string;
  ref?: string;
  public: boolean;
  json: boolean;
  limit?: string;
}

const HELP = help`Usage: kortix crafts <subcommand> [options]

Publish, browse, install and operate crafts. A craft is a Kortix project — a
repository whose kortix.yaml declares agents, skills, connectors and triggers —
that you install into another project.

Subcommands:
  publish <owner/repo>   Index a craft from a GitHub repo. Private by default.
    --ref <branch|tag>   Pin a branch or tag. Default: the default branch.
    --public             List it in the public catalog.
  list | ls              Browse the catalog. --query to filter.
  show <id|slug>         One craft: what it declares and what it needs.
  remove <id>            Withdraw from the catalog. Does NOT uninstall it.

  installed              What the linked project has installed.
  install <id|slug>      Start the agent session that installs it.
  uninstall <slug>       Start the agent session that removes it.
  enable <slug>          Turn this craft's triggers on.
  disable <slug>         Turn this craft's triggers off.
  runs [slug]            Run history. Omit the slug for every craft.

Options:
  --project <id>         Target project (default: the linked one).
  --host <name>          Use a configured Kortix host.
  --limit <n>            Rows to fetch. Default: 50.
  --json                 Machine-readable output.
  -h, --help             Show this help.

A craft installs with every trigger OFF. \`enable\` is what starts it working.
Install and uninstall are agent-driven: each opens a change request you review.
`;

function parseFlags(argv: string[]): CraftFlags {
  return {
    host: takeFlagValue(argv, ['--host']),
    project: takeFlagValue(argv, ['--project']),
    query: takeFlagValue(argv, ['--query', '-q']),
    ref: takeFlagValue(argv, ['--ref', '--branch', '--tag']),
    limit: takeFlagValue(argv, ['--limit']),
    public: takeFlagBool(argv, ['--public']),
    json: takeFlagBool(argv, ['--json']),
  };
}

/** The account-scoped client, for the catalog routes that need no project. */
function resolveCatalogClient(host?: string): { client: ApiClient; auth: Auth } | null {
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

/** First non-flag positional. */
function positional(argv: string[]): string | undefined {
  return argv.find((arg) => !arg.startsWith('-'));
}

function limitOf(flags: CraftFlags): number {
  const parsed = Number(flags.limit);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
}

function ago(iso: string | null): string {
  if (!iso) return '-';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '-';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// ── publishing ──────────────────────────────────────────────────────────────

async function craftsPublish(argv: string[], flags: CraftFlags): Promise<number> {
  const repo = positional(argv);
  if (!repo) {
    process.stderr.write(
      `${status.err('pass a repository: kortix crafts publish acme/seo-craft')}\n`,
    );
    return 2;
  }
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  // The API accepts `owner/repo@ref`, so `--ref` folds into the address rather
  // than being a second field the server has to reconcile with it.
  const address = flags.ref ? `${repo}@${flags.ref}` : repo;
  try {
    const result = await ctx.client.post<{ craft: Craft; warnings: string[] }>('/crafts', {
      repo: address,
      visibility: flags.public ? 'public' : 'private',
    });
    if (flags.json) {
      emitJson(result);
      return 0;
    }
    const craft = result.craft;
    process.stdout.write(
      `${status.ok(`Published ${C.bold}${craft.title}${C.reset}`)}\n` +
        `  ${C.dim}Craft:${C.reset}      ${craft.craft_id}\n` +
        `  ${C.dim}Slug:${C.reset}       ${craft.slug}\n` +
        `  ${C.dim}Source:${C.reset}     ${craft.repo}${craft.git_ref ? `@${craft.git_ref}` : ''}` +
        `${craft.resolved_sha ? ` ${C.faded}(${craft.resolved_sha.slice(0, 7)})${C.reset}` : ''}\n` +
        `  ${C.dim}Visibility:${C.reset} ${craft.visibility}\n` +
        `  ${C.dim}Declares:${C.reset}   ${craft.agents.length} agent(s), ${craft.triggers.length} trigger(s), ` +
        `${craft.connectors.length} connector(s), ${craft.skills.length} skill(s)\n`,
    );
    // Warnings never block — the craft IS indexed — but they must be visible,
    // or a per-entry parse error silently ships a card that under-declares.
    for (const warning of result.warnings) {
      process.stdout.write(`  ${status.warn(warning)}\n`);
    }
    process.stdout.write(
      `\n  ${C.dim}Install it:${C.reset} ${C.cyan}kortix crafts install ${craft.craft_id}${C.reset}\n`,
    );
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function craftsRemove(argv: string[], flags: CraftFlags): Promise<number> {
  const craftId = positional(argv);
  if (!craftId) {
    process.stderr.write(`${status.err('pass a craft id: kortix crafts remove <id>')}\n`);
    return 2;
  }
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  try {
    await ctx.client.delete(`/crafts/${encodeURIComponent(craftId)}`);
    if (flags.json) emitJson({ ok: true, craft_id: craftId });
    else {
      process.stdout.write(
        `${status.ok(`Withdrew ${craftId} from the catalog`)}\n` +
          `  ${C.dim}Projects that already installed it keep it — an install lives in their manifest.${C.reset}\n`,
      );
    }
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

// ── browsing ────────────────────────────────────────────────────────────────

async function craftsList(argv: string[], flags: CraftFlags): Promise<number> {
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  const query = positional(argv) ?? flags.query;
  const params = new URLSearchParams({ limit: String(limitOf(flags)) });
  if (query) params.set('q', query);
  try {
    const res = await ctx.client.get<{ crafts: Craft[]; total: number }>(`/crafts?${params}`);
    if (flags.json) {
      emitJson(res);
      return 0;
    }
    const crafts = res.crafts ?? [];
    if (crafts.length === 0) {
      process.stdout.write(`${status.info(query ? 'No craft matched.' : 'No crafts yet.')}\n`);
      process.stdout.write(
        `\n  ${C.dim}Publish one:${C.reset} ${C.cyan}kortix crafts publish <owner/repo>${C.reset}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `\n  ${C.bold}Crafts${C.reset} ${C.faded}- ${crafts.length} of ${res.total}${C.reset}\n\n`,
    );
    for (const craft of crafts) {
      const flag =
        craft.status === 'active'
          ? craft.visibility === 'private'
            ? ` ${C.faded}[private]${C.reset}`
            : ''
          : ` ${C.faded}[${craft.status}]${C.reset}`;
      process.stdout.write(`  ${C.cyan}${craft.slug}${C.reset}${flag}\n`);
      process.stdout.write(`    ${craft.title} ${C.faded}- ${craft.repo}${C.reset}\n`);
      if (craft.description) {
        process.stdout.write(`    ${C.dim}${craft.description}${C.reset}\n`);
      }
      if (craft.last_error) {
        process.stdout.write(`    ${status.warn(craft.last_error)}\n`);
      }
    }
    process.stdout.write(
      `\n  ${C.dim}Details:${C.reset} ${C.cyan}kortix crafts show <slug>${C.reset}\n`,
    );
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

/** Resolve `<id|slug>` to one craft. An id hits the detail route directly. */
async function findCraft(client: ApiClient, raw: string): Promise<Craft | null> {
  try {
    const res = await client.get<{ craft: Craft }>(`/crafts/${encodeURIComponent(raw)}`);
    return res.craft;
  } catch {
    // Not an id, or not visible. Fall back to a slug search — the slug is what
    // a person reads off `crafts list`, so it must work here too.
    try {
      const res = await client.get<{ crafts: Craft[] }>(
        `/crafts?q=${encodeURIComponent(raw)}&limit=50`,
      );
      const crafts = res.crafts ?? [];
      return crafts.find((c) => c.slug === raw) ?? (crafts.length === 1 ? crafts[0] : null);
    } catch {
      return null;
    }
  }
}

async function craftsShow(argv: string[], flags: CraftFlags): Promise<number> {
  const raw = positional(argv);
  if (!raw) {
    process.stderr.write(`${status.err('pass a craft id or slug: kortix crafts show <slug>')}\n`);
    return 2;
  }
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  const craft = await findCraft(ctx.client, raw);
  if (!craft) {
    process.stderr.write(`${status.err(`No craft matches "${raw}".`)}\n`);
    return 1;
  }
  if (flags.json) {
    emitJson(craft);
    return 0;
  }
  process.stdout.write(`\n  ${C.bold}${craft.title}${C.reset} ${C.faded}(${craft.slug})${C.reset}\n`);
  process.stdout.write(`  ${C.dim}${craft.craft_id}${C.reset}\n`);
  if (craft.description) process.stdout.write(`\n  ${craft.description}\n`);
  process.stdout.write(
    `\n  ${C.dim}Source:${C.reset}     ${craft.repo}${craft.git_ref ? `@${craft.git_ref}` : ''}` +
      `${craft.resolved_sha ? ` ${C.faded}(${craft.resolved_sha.slice(0, 7)})${C.reset}` : ''}\n`,
  );
  process.stdout.write(`  ${C.dim}Visibility:${C.reset} ${craft.visibility}\n`);
  process.stdout.write(`  ${C.dim}Installs:${C.reset}   ${craft.install_count}\n`);
  if (craft.agents.length > 0) {
    process.stdout.write(
      `\n  ${C.dim}Agents:${C.reset}     ${craft.agents.map((a) => a.name).join(', ')}\n`,
    );
  }
  if (craft.skills.length > 0) {
    process.stdout.write(`  ${C.dim}Skills:${C.reset}     ${craft.skills.join(', ')}\n`);
  }
  if (craft.triggers.length > 0) {
    process.stdout.write(`  ${C.dim}Triggers:${C.reset}\n`);
    for (const trigger of craft.triggers) {
      process.stdout.write(
        `    ${trigger.slug}${trigger.cron ? ` ${C.faded}${trigger.cron}${C.reset}` : ''}\n`,
      );
    }
  }
  // The two lists that gate an install: what has to be connected, and what
  // secrets have to exist. Printed even when empty is wrong — printed loudly
  // when non-empty is the point.
  if (craft.connectors.length > 0) {
    process.stdout.write(
      `  ${C.dim}Needs connected:${C.reset} ${craft.connectors.map((c) => c.app ?? c.slug).join(', ')}\n`,
    );
  }
  if (craft.env_required.length > 0) {
    process.stdout.write(`  ${C.dim}Needs env:${C.reset}  ${craft.env_required.join(', ')}\n`);
  }
  if (craft.status !== 'active') {
    process.stdout.write(`\n  ${status.warn(`This craft is ${craft.status}.`)}\n`);
    if (craft.last_error) process.stdout.write(`  ${C.dim}${craft.last_error}${C.reset}\n`);
  }
  process.stdout.write(
    `\n  ${C.dim}Install:${C.reset} ${C.cyan}kortix crafts install ${craft.slug}${C.reset}\n`,
  );
  return 0;
}

// ── per-project ─────────────────────────────────────────────────────────────

async function craftsInstalled(flags: CraftFlags): Promise<number> {
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  try {
    const res = await ctx.client.get<{
      crafts: InstalledCraft[];
      errors: Array<{ slug: string; error: string }>;
    }>(`/projects/${ctx.projectId}/crafts`);
    if (flags.json) {
      emitJson(res);
      return 0;
    }
    const crafts = res.crafts ?? [];
    if (crafts.length === 0) {
      process.stdout.write(`${status.info('No craft is installed in this project.')}\n`);
      process.stdout.write(
        `\n  ${C.dim}Browse:${C.reset} ${C.cyan}kortix crafts list${C.reset}\n`,
      );
    } else {
      process.stdout.write(
        `\n  ${C.bold}Installed${C.reset} ${C.faded}- ${crafts.length} craft${crafts.length === 1 ? '' : 's'}${C.reset}\n\n`,
      );
      for (const craft of crafts) {
        process.stdout.write(`  ${C.cyan}${craft.slug}${C.reset} ${C.faded}${craft.repo}${C.reset}\n`);
        process.stdout.write(
          `    ${craft.title}${craft.sha ? ` ${C.faded}(${craft.sha.slice(0, 7)})${C.reset}` : ''}\n`,
        );
        const owns = Object.entries(craft.owns).filter(([, list]) => (list ?? []).length > 0);
        for (const [kind, list] of owns) {
          process.stdout.write(`    ${C.dim}${kind}:${C.reset} ${(list ?? []).join(', ')}\n`);
        }
      }
    }
    // A per-entry parse error must be visible: the craft is in the manifest but
    // could not be read, which is exactly the state a silent list would hide.
    for (const error of res.errors ?? []) {
      process.stdout.write(`  ${status.warn(`${error.slug}: ${error.error}`)}\n`);
    }
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function craftsInstall(argv: string[], flags: CraftFlags): Promise<number> {
  const raw = positional(argv);
  if (!raw) {
    process.stderr.write(
      `${status.err('pass a craft id or slug: kortix crafts install <slug>')}\n`,
    );
    return 2;
  }
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  // Resolve to a craft ID first: the install route takes an id, and a person at
  // a terminal has the slug they read off `crafts list`.
  const craft = await findCraft(ctx.client, raw);
  if (!craft) {
    process.stderr.write(`${status.err(`No craft matches "${raw}".`)}\n`);
    return 1;
  }
  try {
    const result = await ctx.client.post<{ session_id: string }>(
      `/projects/${ctx.projectId}/crafts/install-session`,
      { craft_id: craft.craft_id },
    );
    if (flags.json) {
      emitJson({ ...result, project_id: ctx.projectId, craft_id: craft.craft_id });
      return 0;
    }
    process.stdout.write(
      `${status.ok(`Started install session ${C.bold}${result.session_id}${C.reset}`)}\n` +
        `  ${C.dim}Craft:${C.reset} ${craft.title} (${craft.slug})\n` +
        `\n  ${C.dim}The agent merges it and opens a change request. Follow along:${C.reset}\n` +
        `  ${C.cyan}kortix sessions logs ${result.session_id}${C.reset}\n` +
        `\n  ${C.dim}Its triggers ship OFF. After the CR merges:${C.reset}\n` +
        `  ${C.cyan}kortix crafts enable ${craft.slug}${C.reset}\n`,
    );
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function craftsUninstall(argv: string[], flags: CraftFlags): Promise<number> {
  const slug = positional(argv);
  if (!slug) {
    process.stderr.write(
      `${status.err('pass an installed slug: kortix crafts uninstall <slug>')}\n`,
    );
    return 2;
  }
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  try {
    const result = await ctx.client.post<{ session_id: string }>(
      `/projects/${ctx.projectId}/crafts/${encodeURIComponent(slug)}/uninstall-session`,
      {},
    );
    if (flags.json) emitJson({ ...result, project_id: ctx.projectId, craft_slug: slug });
    else {
      process.stdout.write(
        `${status.ok(`Started uninstall session ${C.bold}${result.session_id}${C.reset}`)}\n` +
          `  ${C.dim}Craft:${C.reset} ${slug}\n` +
          `\n  ${C.dim}It opens a change request that removes what the craft contributed.${C.reset}\n`,
      );
    }
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function craftsActivation(
  argv: string[],
  flags: CraftFlags,
  enabled: boolean,
): Promise<number> {
  const slug = positional(argv);
  if (!slug) {
    process.stderr.write(
      `${status.err(`pass an installed slug: kortix crafts ${enabled ? 'enable' : 'disable'} <slug>`)}\n`,
    );
    return 2;
  }
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  try {
    const result = await ctx.client.patch<{
      craft_slug: string;
      title: string;
      enabled: boolean;
      triggers: string[];
    }>(`/projects/${ctx.projectId}/crafts/${encodeURIComponent(slug)}/activation`, { enabled });
    if (flags.json) {
      emitJson(result);
      return 0;
    }
    // An empty list is a real, distinct outcome: nothing moved because it was
    // already in this state. Reporting "enabled" for both would be a lie.
    if (result.triggers.length === 0) {
      process.stdout.write(
        `${status.info(`${result.title} was already ${enabled ? 'enabled' : 'disabled'}`)}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `${status.ok(`${enabled ? 'Enabled' : 'Disabled'} ${C.bold}${result.title}${C.reset}`)}\n` +
        `  ${C.dim}Triggers:${C.reset} ${result.triggers.join(', ')}\n`,
    );
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function craftsRuns(argv: string[], flags: CraftFlags): Promise<number> {
  const slug = positional(argv);
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  const params = new URLSearchParams({ limit: String(limitOf(flags)) });
  const path = slug
    ? `/projects/${ctx.projectId}/crafts/${encodeURIComponent(slug)}/runs?${params}`
    : `/projects/${ctx.projectId}/crafts/runs?${params}`;
  try {
    const res = await ctx.client.get<{
      runs: CraftRun[];
      total: number;
      stats?: { total: number; done: number; failed: number; successRate: number | null };
    }>(path);
    if (flags.json) {
      emitJson(res);
      return 0;
    }
    const runs = res.runs ?? [];
    if (runs.length === 0) {
      process.stdout.write(
        `${status.info(slug ? `No run yet for "${slug}".` : 'No craft has run in this project.')}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `\n  ${C.bold}Craft runs${C.reset} ${C.faded}- ${runs.length} of ${res.total}${C.reset}\n\n`,
    );
    for (const run of runs) {
      const tone = run.status === 'failed' ? C.red : run.status === 'done' ? C.dim : C.cyan;
      process.stdout.write(
        `  ${tone}${run.status.padEnd(9)}${C.reset} ${C.faded}${ago(run.created_at).padStart(4)}${C.reset}  ` +
          `${run.craft_slug}/${run.trigger_slug}\n`,
      );
      const detail = run.summary ?? run.last_error;
      if (detail) process.stdout.write(`    ${C.dim}${detail}${C.reset}\n`);
      if (run.session_id) {
        process.stdout.write(`    ${C.faded}session ${run.session_id}${C.reset}\n`);
      }
    }
    if (res.stats) {
      process.stdout.write(
        `\n  ${C.dim}${res.stats.done} done, ${res.stats.failed} failed` +
          `${res.stats.successRate === null ? '' : `, ${res.stats.successRate}% success`}${C.reset}\n`,
      );
    }
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

export async function runCrafts(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // The root help promises `kortix <cmd> <subcommand> --help`. No subcommand
  // here owns dedicated help text, so without this a bare `--help` falls
  // through as a positional and the command runs instead of printing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const flags = parseFlags(rest);

  switch (sub) {
    case 'publish':
    case 'submit':
      return craftsPublish(rest, flags);
    case 'list':
    case 'ls':
    case 'search':
      return craftsList(rest, flags);
    case 'show':
    case 'view':
      return craftsShow(rest, flags);
    case 'remove':
    case 'rm':
    case 'delete':
      return craftsRemove(rest, flags);
    case 'installed':
      return craftsInstalled(flags);
    case 'install':
      return craftsInstall(rest, flags);
    case 'uninstall':
      return craftsUninstall(rest, flags);
    case 'enable':
      return craftsActivation(rest, flags, true);
    case 'disable':
      return craftsActivation(rest, flags, false);
    case 'runs':
      return craftsRuns(rest, flags);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}
