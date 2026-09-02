/**
 * `kortix subprojects <subcommand>` — publish, browse, install and uninstall
 * subprojects.
 *
 * A subproject is a Kortix project you install into another project: a repository
 * whose `kortix.yaml` declares agents, skills, connectors and triggers.
 *
 * Three things this command deliberately does NOT do:
 *
 *  - **It does not merge anything.** `install` starts an agent session that
 *    reads both manifests, resolves name collisions, and opens a change
 *    request, for this reason:
 *    merging into a live project is judgment, not a file copy.
 *  - **It does not upload a .zip.** Publishing from an archive exists on the
 *    web, for a folder that is not a repo yet. By the time you are at a
 *    terminal you have a repo, and a subproject that tracks one gets re-crawled when
 *    it moves; an uploaded snapshot never does.
 *  - **It does not run, enable or report on anything.** A subproject has no
 *    on/off state: it is a set of entries in a project's manifest. Its triggers
 *    are enabled one at a time under `kortix triggers`, and their runs belong
 *    to the trigger that fired, not to the subproject that contributed it.
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

interface Subproject {
  subproject_id: string;
  slug: string;
  source_kind: 'github' | 'upload';
  repo: string;
  git_ref: string | null;
  resolved_sha: string | null;
  title: string;
  description: string | null;
  stars: number | null;
  install_count: number;
  /**
   * `public` rows come from a migration, a seeder or a direct insert — `publish`
   * cannot ask for one. So this reads three values but writes two.
   */
  visibility: 'public' | 'account' | 'private';
  status: 'active' | 'unavailable' | 'yanked';
  agents: Array<{ name: string }>;
  triggers: Array<{ slug: string; cron: string | null; enabled: boolean }>;
  connectors: Array<{ slug: string; app: string | null }>;
  skills: string[];
  env_required: string[];
  last_error: string | null;
}

interface InstalledSubproject {
  slug: string;
  repo: string;
  sha: string | null;
  version: string | null;
  title: string;
  installed_at: string | null;
  owns: Partial<Record<'agents' | 'skills' | 'connectors' | 'triggers', string[]>>;
}

interface SubprojectFlags {
  host?: string;
  project?: string;
  query?: string;
  ref?: string;
  private: boolean;
  json: boolean;
  limit?: string;
}

const HELP = help`Usage: kortix subprojects <subcommand> [options]

Publish, browse, install and uninstall subprojects. A subproject is a Kortix
project — a repository whose kortix.yaml declares agents, skills, connectors and
triggers — that you install into another project.

Subcommands:
  publish <owner/repo>   Index a subproject. Your whole account can see it.
    --ref <branch|tag>   Pin a branch or tag. Default: the default branch.
    --private            Only you can see it.
  list | ls              Browse the catalog. --query to filter.
  show <id|slug>         One subproject: what it declares and what it needs.
  remove <id>            Withdraw from the catalog. Does NOT uninstall it.

  installed              What the linked project has installed.
  install <id|slug>      Start the agent session that installs it.
  uninstall <slug>       Start the agent session that removes it.

Options:
  --project <id>         Target project (default: the linked one).
  --host <name>          Use a configured Kortix host.
  --limit <n>            Rows to fetch. Default: 50.
  --json                 Machine-readable output.
  -h, --help             Show this help.

Install and uninstall are agent-driven: each opens a change request you review.
A subproject installs with every trigger OFF. Turn them on one at a time with
\`kortix triggers enable <slug>\` — a subproject has no on/off of its own.

There is no way to publish a subproject every Kortix user can see. Those rows
are curated, and only a migration, a seeder or a direct insert creates one.
`;

function parseFlags(argv: string[]): SubprojectFlags {
  return {
    host: takeFlagValue(argv, ['--host']),
    project: takeFlagValue(argv, ['--project']),
    query: takeFlagValue(argv, ['--query', '-q']),
    ref: takeFlagValue(argv, ['--ref', '--branch', '--tag']),
    limit: takeFlagValue(argv, ['--limit']),
    private: takeFlagBool(argv, ['--private']),
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

function limitOf(flags: SubprojectFlags): number {
  const parsed = Number(flags.limit);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
}

// ── publishing ──────────────────────────────────────────────────────────────

async function subprojectsPublish(argv: string[], flags: SubprojectFlags): Promise<number> {
  const repo = positional(argv);
  if (!repo) {
    process.stderr.write(
      `${status.err('pass a repository: kortix subprojects publish acme/seo-subproject')}\n`,
    );
    return 2;
  }
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  // The API accepts `owner/repo@ref`, so `--ref` folds into the address rather
  // than being a second field the server has to reconcile with it.
  const address = flags.ref ? `${repo}@${flags.ref}` : repo;
  try {
    // Only sent when narrowing. The server defaults to `account`, and `public`
    // is not a value this route accepts from anybody.
    const result = await ctx.client.post<{ subproject: Subproject; warnings: string[] }>(
      '/subprojects',
      {
        repo: address,
        ...(flags.private ? { visibility: 'private' } : {}),
      },
    );
    if (flags.json) {
      emitJson(result);
      return 0;
    }
    const subproject = result.subproject;
    process.stdout.write(
      `${status.ok(`Published ${C.bold}${subproject.title}${C.reset}`)}\n` +
        `  ${C.dim}Subproject:${C.reset}      ${subproject.subproject_id}\n` +
        `  ${C.dim}Slug:${C.reset}       ${subproject.slug}\n` +
        `  ${C.dim}Source:${C.reset}     ${subproject.repo}${subproject.git_ref ? `@${subproject.git_ref}` : ''}` +
        `${subproject.resolved_sha ? ` ${C.faded}(${subproject.resolved_sha.slice(0, 7)})${C.reset}` : ''}\n` +
        `  ${C.dim}Visibility:${C.reset} ${subproject.visibility}\n` +
        `  ${C.dim}Declares:${C.reset}   ${subproject.agents.length} agent(s), ${subproject.triggers.length} trigger(s), ` +
        `${subproject.connectors.length} connector(s), ${subproject.skills.length} skill(s)\n`,
    );
    // Warnings never block — the subproject IS indexed — but they must be visible,
    // or a per-entry parse error silently ships a card that under-declares.
    for (const warning of result.warnings) {
      process.stdout.write(`  ${status.warn(warning)}\n`);
    }
    process.stdout.write(
      `\n  ${C.dim}Install it:${C.reset} ${C.cyan}kortix subprojects install ${subproject.subproject_id}${C.reset}\n`,
    );
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function subprojectsRemove(argv: string[], flags: SubprojectFlags): Promise<number> {
  const subprojectId = positional(argv);
  if (!subprojectId) {
    process.stderr.write(`${status.err('pass a subproject id: kortix subprojects remove <id>')}\n`);
    return 2;
  }
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  try {
    await ctx.client.delete(`/subprojects/${encodeURIComponent(subprojectId)}`);
    if (flags.json) emitJson({ ok: true, subproject_id: subprojectId });
    else {
      process.stdout.write(
        `${status.ok(`Withdrew ${subprojectId} from the catalog`)}\n` +
          `  ${C.dim}Projects that already installed it keep it — an install lives in their manifest.${C.reset}\n`,
      );
    }
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

// ── browsing ────────────────────────────────────────────────────────────────

async function subprojectsList(argv: string[], flags: SubprojectFlags): Promise<number> {
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  const query = positional(argv) ?? flags.query;
  const params = new URLSearchParams({ limit: String(limitOf(flags)) });
  if (query) params.set('q', query);
  try {
    const res = await ctx.client.get<{ subprojects: Subproject[]; total: number }>(
      `/subprojects?${params}`,
    );
    if (flags.json) {
      emitJson(res);
      return 0;
    }
    const subprojects = res.subprojects ?? [];
    if (subprojects.length === 0) {
      process.stdout.write(
        `${status.info(query ? 'No subproject matched.' : 'No subprojects yet.')}\n`,
      );
      process.stdout.write(
        `\n  ${C.dim}Publish one:${C.reset} ${C.cyan}kortix subprojects publish <owner/repo>${C.reset}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `\n  ${C.bold}Subprojects${C.reset} ${C.faded}- ${subprojects.length} of ${res.total}${C.reset}\n\n`,
    );
    for (const subproject of subprojects) {
      // `account` is the default scope and carries no badge — badging the
      // common case is noise. The two ends of the range are worth naming:
      // `private` is yours alone, `global` is curated by Kortix.
      const visibilityFlag =
        subproject.visibility === 'private'
          ? ` ${C.faded}[private]${C.reset}`
          : subproject.visibility === 'public'
            ? ` ${C.faded}[global]${C.reset}`
            : '';
      const flag =
        subproject.status === 'active'
          ? visibilityFlag
          : ` ${C.faded}[${subproject.status}]${C.reset}`;
      process.stdout.write(`  ${C.cyan}${subproject.slug}${C.reset}${flag}\n`);
      process.stdout.write(`    ${subproject.title} ${C.faded}- ${subproject.repo}${C.reset}\n`);
      if (subproject.description) {
        process.stdout.write(`    ${C.dim}${subproject.description}${C.reset}\n`);
      }
      if (subproject.last_error) {
        process.stdout.write(`    ${status.warn(subproject.last_error)}\n`);
      }
    }
    process.stdout.write(
      `\n  ${C.dim}Details:${C.reset} ${C.cyan}kortix subprojects show <slug>${C.reset}\n`,
    );
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

/** Resolve `<id|slug>` to one subproject. An id hits the detail route directly. */
async function findSubproject(client: ApiClient, raw: string): Promise<Subproject | null> {
  try {
    const res = await client.get<{ subproject: Subproject }>(
      `/subprojects/${encodeURIComponent(raw)}`,
    );
    return res.subproject;
  } catch {
    // Not an id, or not visible. Fall back to a slug search — the slug is what
    // a person reads off `subprojects list`, so it must work here too.
    try {
      const res = await client.get<{ subprojects: Subproject[] }>(
        `/subprojects?q=${encodeURIComponent(raw)}&limit=50`,
      );
      const subprojects = res.subprojects ?? [];
      return (
        subprojects.find((c) => c.slug === raw) ??
        (subprojects.length === 1 ? subprojects[0] : null)
      );
    } catch {
      return null;
    }
  }
}

async function subprojectsShow(argv: string[], flags: SubprojectFlags): Promise<number> {
  const raw = positional(argv);
  if (!raw) {
    process.stderr.write(
      `${status.err('pass a subproject id or slug: kortix subprojects show <slug>')}\n`,
    );
    return 2;
  }
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  const subproject = await findSubproject(ctx.client, raw);
  if (!subproject) {
    process.stderr.write(`${status.err(`No subproject matches "${raw}".`)}\n`);
    return 1;
  }
  if (flags.json) {
    emitJson(subproject);
    return 0;
  }
  process.stdout.write(
    `\n  ${C.bold}${subproject.title}${C.reset} ${C.faded}(${subproject.slug})${C.reset}\n`,
  );
  process.stdout.write(`  ${C.dim}${subproject.subproject_id}${C.reset}\n`);
  if (subproject.description) process.stdout.write(`\n  ${subproject.description}\n`);
  process.stdout.write(
    `\n  ${C.dim}Source:${C.reset}     ${subproject.repo}${subproject.git_ref ? `@${subproject.git_ref}` : ''}` +
      `${subproject.resolved_sha ? ` ${C.faded}(${subproject.resolved_sha.slice(0, 7)})${C.reset}` : ''}\n`,
  );
  process.stdout.write(`  ${C.dim}Visibility:${C.reset} ${subproject.visibility}\n`);
  process.stdout.write(`  ${C.dim}Installs:${C.reset}   ${subproject.install_count}\n`);
  if (subproject.agents.length > 0) {
    process.stdout.write(
      `\n  ${C.dim}Agents:${C.reset}     ${subproject.agents.map((a) => a.name).join(', ')}\n`,
    );
  }
  if (subproject.skills.length > 0) {
    process.stdout.write(`  ${C.dim}Skills:${C.reset}     ${subproject.skills.join(', ')}\n`);
  }
  if (subproject.triggers.length > 0) {
    process.stdout.write(`  ${C.dim}Triggers:${C.reset}\n`);
    for (const trigger of subproject.triggers) {
      process.stdout.write(
        `    ${trigger.slug}${trigger.cron ? ` ${C.faded}${trigger.cron}${C.reset}` : ''}\n`,
      );
    }
  }
  // The two lists that gate an install: what has to be connected, and what
  // secrets have to exist. Printed even when empty is wrong — printed loudly
  // when non-empty is the point.
  if (subproject.connectors.length > 0) {
    process.stdout.write(
      `  ${C.dim}Needs connected:${C.reset} ${subproject.connectors.map((c) => c.app ?? c.slug).join(', ')}\n`,
    );
  }
  if (subproject.env_required.length > 0) {
    process.stdout.write(`  ${C.dim}Needs env:${C.reset}  ${subproject.env_required.join(', ')}\n`);
  }
  if (subproject.status !== 'active') {
    process.stdout.write(`\n  ${status.warn(`This subproject is ${subproject.status}.`)}\n`);
    if (subproject.last_error)
      process.stdout.write(`  ${C.dim}${subproject.last_error}${C.reset}\n`);
  }
  process.stdout.write(
    `\n  ${C.dim}Install:${C.reset} ${C.cyan}kortix subprojects install ${subproject.slug}${C.reset}\n`,
  );
  return 0;
}

// ── per-project ─────────────────────────────────────────────────────────────

async function subprojectsInstalled(flags: SubprojectFlags): Promise<number> {
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  try {
    const res = await ctx.client.get<{
      subprojects: InstalledSubproject[];
      errors: Array<{ slug: string; error: string }>;
    }>(`/projects/${ctx.projectId}/subprojects`);
    if (flags.json) {
      emitJson(res);
      return 0;
    }
    const subprojects = res.subprojects ?? [];
    if (subprojects.length === 0) {
      process.stdout.write(`${status.info('No subproject is installed in this project.')}\n`);
      process.stdout.write(
        `\n  ${C.dim}Browse:${C.reset} ${C.cyan}kortix subprojects list${C.reset}\n`,
      );
    } else {
      process.stdout.write(
        `\n  ${C.bold}Installed${C.reset} ${C.faded}- ${subprojects.length} subproject${subprojects.length === 1 ? '' : 's'}${C.reset}\n\n`,
      );
      for (const subproject of subprojects) {
        process.stdout.write(
          `  ${C.cyan}${subproject.slug}${C.reset} ${C.faded}${subproject.repo}${C.reset}\n`,
        );
        process.stdout.write(
          `    ${subproject.title}${subproject.sha ? ` ${C.faded}(${subproject.sha.slice(0, 7)})${C.reset}` : ''}\n`,
        );
        const owns = Object.entries(subproject.owns).filter(([, list]) => (list ?? []).length > 0);
        for (const [kind, list] of owns) {
          process.stdout.write(`    ${C.dim}${kind}:${C.reset} ${(list ?? []).join(', ')}\n`);
        }
      }
    }
    // A per-entry parse error must be visible: the subproject is in the manifest but
    // could not be read, which is exactly the state a silent list would hide.
    for (const error of res.errors ?? []) {
      process.stdout.write(`  ${status.warn(`${error.slug}: ${error.error}`)}\n`);
    }
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function subprojectsInstall(argv: string[], flags: SubprojectFlags): Promise<number> {
  const raw = positional(argv);
  if (!raw) {
    process.stderr.write(
      `${status.err('pass a subproject id or slug: kortix subprojects install <slug>')}\n`,
    );
    return 2;
  }
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  // Resolve to a subproject ID first: the install route takes an id, and a person at
  // a terminal has the slug they read off `subprojects list`.
  const subproject = await findSubproject(ctx.client, raw);
  if (!subproject) {
    process.stderr.write(`${status.err(`No subproject matches "${raw}".`)}\n`);
    return 1;
  }
  try {
    const result = await ctx.client.post<{ session_id: string }>(
      `/projects/${ctx.projectId}/subprojects/install-session`,
      { subproject_id: subproject.subproject_id },
    );
    if (flags.json) {
      emitJson({ ...result, project_id: ctx.projectId, subproject_id: subproject.subproject_id });
      return 0;
    }
    process.stdout.write(
      `${status.ok(`Started install session ${C.bold}${result.session_id}${C.reset}`)}\n` +
        `  ${C.dim}Subproject:${C.reset} ${subproject.title} (${subproject.slug})\n` +
        `\n  ${C.dim}The agent merges it and opens a change request. Follow along:${C.reset}\n` +
        `  ${C.cyan}kortix sessions logs ${result.session_id}${C.reset}\n` +
        `\n  ${C.dim}Its triggers ship OFF. After the CR merges, turn them on:${C.reset}\n` +
        `  ${C.cyan}kortix triggers list${C.reset}\n`,
    );
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function subprojectsUninstall(argv: string[], flags: SubprojectFlags): Promise<number> {
  const slug = positional(argv);
  if (!slug) {
    process.stderr.write(
      `${status.err('pass an installed slug: kortix subprojects uninstall <slug>')}\n`,
    );
    return 2;
  }
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  try {
    const result = await ctx.client.post<{ session_id: string }>(
      `/projects/${ctx.projectId}/subprojects/${encodeURIComponent(slug)}/uninstall-session`,
      {},
    );
    if (flags.json) emitJson({ ...result, project_id: ctx.projectId, subproject_slug: slug });
    else {
      process.stdout.write(
        `${status.ok(`Started uninstall session ${C.bold}${result.session_id}${C.reset}`)}\n` +
          `  ${C.dim}Subproject:${C.reset} ${slug}\n` +
          `\n  ${C.dim}It opens a change request that removes what the subproject contributed.${C.reset}\n`,
      );
    }
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

export async function runSubprojects(argv: string[]): Promise<number> {
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
      return subprojectsPublish(rest, flags);
    case 'list':
    case 'ls':
    case 'search':
      return subprojectsList(rest, flags);
    case 'show':
    case 'view':
      return subprojectsShow(rest, flags);
    case 'remove':
    case 'rm':
    case 'delete':
      return subprojectsRemove(rest, flags);
    case 'installed':
      return subprojectsInstalled(flags);
    case 'install':
      return subprojectsInstall(rest, flags);
    case 'uninstall':
      return subprojectsUninstall(rest, flags);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}
