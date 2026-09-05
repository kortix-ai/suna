/**
 * `kortix marketplace <subcommand>` — browse the template catalog and install a
 * template into a project.
 *
 * A template is a public GitHub repository whose `kortix.yaml` declares agents,
 * skills, connectors and triggers.
 *
 * Two things this command deliberately does NOT do:
 *
 *  - **It does not merge anything.** `install` starts an agent session that
 *    reads both manifests, resolves name collisions, and opens a change
 *    request: merging into a live project is judgment, not a file copy.
 *  - **It does not publish, list what is installed, or uninstall.** The catalog
 *    is curated and ships with the API. What a project installed is the change
 *    request the install opened, and reverting it is the uninstall.
 */

import { type Auth, loadAuth, loadAuthForHost } from '../api/auth.ts';
import type { ApiClient } from '../api/client.ts';
import { clientFromAuth } from '../api/client.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

interface MarketplaceTemplate {
  slug: string;
  title: string;
  description: string | null;
  repo: string;
  git_ref: string | null;
  resolved_sha: string;
  agents: Array<{ name: string }>;
  triggers: Array<{ slug: string; cron: string | null; enabled: boolean }>;
  connectors: Array<{ slug: string; app: string | null }>;
  skills: string[];
  env_required: string[];
}

interface MarketplaceFlags {
  host?: string;
  project?: string;
  query?: string;
  json: boolean;
}

const HELP = help`Usage: kortix marketplace <subcommand> [options]

Browse the template catalog and install a template. A template is a Kortix
project — a repository whose kortix.yaml declares agents, skills, connectors and
triggers — that you install into your own project.

Subcommands:
  list | ls              Browse the catalog. --query to filter.
  show <slug>            One template: what it declares and what it needs.
  install <slug>         Start the agent session that installs it.

Options:
  --project <id>         Target project for install (default: the linked one).
  --host <name>          Use a configured Kortix host.
  --query <text>         Filter the catalog. Alias: -q.
  --json                 Machine-readable output.
  -h, --help             Show this help.

Install is agent-driven: it opens a change request you review, and everything
the template adds lands in that one change request — revert it to uninstall.
A template installs with every trigger OFF. Turn them on one at a time with
\`kortix triggers enable <slug>\`.
`;

function parseFlags(argv: string[]): MarketplaceFlags {
  return {
    host: takeFlagValue(argv, ['--host']),
    project: takeFlagValue(argv, ['--project']),
    query: takeFlagValue(argv, ['--query', '-q']),
    json: takeFlagBool(argv, ['--json']),
  };
}

/** The client for the catalog routes, which need no project. */
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

async function fetchTemplate(client: ApiClient, slug: string): Promise<MarketplaceTemplate | null> {
  try {
    const res = await client.get<{ template: MarketplaceTemplate }>(
      `/public/marketplace/templates/${encodeURIComponent(slug)}`,
    );
    return res.template;
  } catch {
    return null;
  }
}

function printSource(template: MarketplaceTemplate): string {
  return (
    `${template.repo}${template.git_ref ? `@${template.git_ref}` : ''}` +
    ` ${C.faded}(${template.resolved_sha.slice(0, 7)})${C.reset}`
  );
}

// ── browsing ────────────────────────────────────────────────────────────────

async function marketplaceList(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  const query = positional(argv) ?? flags.query;
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const suffix = params.size > 0 ? `?${params}` : '';
  try {
    const res = await ctx.client.get<{ templates: MarketplaceTemplate[] }>(
      `/public/marketplace/templates${suffix}`,
    );
    if (flags.json) {
      emitJson(res);
      return 0;
    }
    const templates = res.templates ?? [];
    if (templates.length === 0) {
      process.stdout.write(
        `${status.info(query ? 'No template matched.' : 'The catalog is empty.')}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `\n  ${C.bold}Marketplace${C.reset} ${C.faded}- ${templates.length} template${templates.length === 1 ? '' : 's'}${C.reset}\n\n`,
    );
    for (const template of templates) {
      process.stdout.write(`  ${C.cyan}${template.slug}${C.reset}\n`);
      process.stdout.write(`    ${template.title} ${C.faded}- ${template.repo}${C.reset}\n`);
      if (template.description) {
        process.stdout.write(`    ${C.dim}${template.description}${C.reset}\n`);
      }
    }
    process.stdout.write(
      `\n  ${C.dim}Details:${C.reset} ${C.cyan}kortix marketplace show <slug>${C.reset}\n`,
    );
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function marketplaceShow(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const slug = positional(argv);
  if (!slug) {
    process.stderr.write(`${status.err('pass a template slug: kortix marketplace show <slug>')}\n`);
    return 2;
  }
  const ctx = resolveCatalogClient(flags.host);
  if (!ctx) return 1;
  const template = await fetchTemplate(ctx.client, slug);
  if (!template) {
    process.stderr.write(`${status.err(`No template matches "${slug}".`)}\n`);
    return 1;
  }
  if (flags.json) {
    emitJson(template);
    return 0;
  }
  process.stdout.write(
    `\n  ${C.bold}${template.title}${C.reset} ${C.faded}(${template.slug})${C.reset}\n`,
  );
  if (template.description) process.stdout.write(`\n  ${template.description}\n`);
  process.stdout.write(`\n  ${C.dim}Source:${C.reset}     ${printSource(template)}\n`);
  if (template.agents.length > 0) {
    process.stdout.write(
      `\n  ${C.dim}Agents:${C.reset}     ${template.agents.map((a) => a.name).join(', ')}\n`,
    );
  }
  if (template.skills.length > 0) {
    process.stdout.write(`  ${C.dim}Skills:${C.reset}     ${template.skills.join(', ')}\n`);
  }
  if (template.triggers.length > 0) {
    process.stdout.write(`  ${C.dim}Triggers:${C.reset}\n`);
    for (const trigger of template.triggers) {
      process.stdout.write(
        `    ${trigger.slug}${trigger.cron ? ` ${C.faded}${trigger.cron}${C.reset}` : ''}\n`,
      );
    }
  }
  // The two lists that gate an install: what has to be connected, and what
  // secrets have to exist. Printed loudly when non-empty is the point.
  if (template.connectors.length > 0) {
    process.stdout.write(
      `  ${C.dim}Needs connected:${C.reset} ${template.connectors.map((c) => c.app ?? c.slug).join(', ')}\n`,
    );
  }
  if (template.env_required.length > 0) {
    process.stdout.write(`  ${C.dim}Needs env:${C.reset}  ${template.env_required.join(', ')}\n`);
  }
  process.stdout.write(
    `\n  ${C.dim}Install:${C.reset} ${C.cyan}kortix marketplace install ${template.slug}${C.reset}\n`,
  );
  return 0;
}

// ── per-project ─────────────────────────────────────────────────────────────

async function marketplaceInstall(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const slug = positional(argv);
  if (!slug) {
    process.stderr.write(
      `${status.err('pass a template slug: kortix marketplace install <slug>')}\n`,
    );
    return 2;
  }
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  try {
    const result = await ctx.client.post<{ session_id: string }>(
      `/projects/${ctx.projectId}/marketplace/install-session`,
      { slug },
    );
    if (flags.json) {
      emitJson({ ...result, project_id: ctx.projectId, slug });
      return 0;
    }
    process.stdout.write(
      `${status.ok(`Started install session ${C.bold}${result.session_id}${C.reset}`)}\n` +
        `  ${C.dim}Template:${C.reset} ${slug}\n` +
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

export async function runMarketplace(argv: string[]): Promise<number> {
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
    case 'list':
    case 'ls':
    case 'search':
      return marketplaceList(rest, flags);
    case 'show':
    case 'view':
      return marketplaceShow(rest, flags);
    case 'install':
      return marketplaceInstall(rest, flags);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}
