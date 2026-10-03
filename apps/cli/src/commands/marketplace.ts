/** Marketplace discovery and agent-driven, verified installs. */

import { loadAuth, loadAuthForHost, type Auth } from '../api/auth.ts';
import { clientFromAuth, createApiClient, type ApiClient } from '../api/client.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

interface CatalogItem {
  id: string;
  registry: string;
  name: string;
  type: string;
  title: string;
  description: string | null;
  categories: string[];
  capabilities: { secrets: string[]; connectors: string[]; tools: string[]; network: string[] };
  dependencies: string[];
  fileCount: number;
  external: boolean;
  marketplaceId: string;
  marketplaceLabel: string;
  managedBy?: 'kortix';
  updatePolicy?: 'kortix-managed';
  defaultProjectInstall?: boolean;
  defaultProjectInstallOrder?: number;
}

interface CatalogResponse {
  items: CatalogItem[];
  loading?: boolean;
  pending?: string[];
}

interface MarketplaceFlags {
  host?: string;
  project?: string;
  query?: string;
  type?: string;
  source?: string;
  json: boolean;
  timeout?: string;
}

const HELP = help`Usage: kortix marketplace <subcommand> [options]

Browse the Kortix marketplace.

Subcommands:
  search [query]       Search marketplace items.
  list                 List marketplace items.
  show <id|name>       Show one marketplace item.
  install <id|name>    Wait for an agent import and verify default-branch files.

Options:
  --query <text>       Search text (same as search [query]).
  --type <type>        Filter by item type, e.g. skill.
  --source <source>    Filter by marketplace/source, e.g. kortix.
  --host <name>        Use a configured Kortix host.
  --project <id>       Install into this project id (default: linked).
  --timeout <seconds>  Install deadline (default: 300).
  --json               Machine-readable output.
  -h, --help           Show this help.

Install is agent-driven. It starts a project session that clones, reads, merges
what fits, and opens a change request.
`;

function parseFlags(argv: string[]): MarketplaceFlags {
  return {
    timeout: takeFlagValue(argv, ['--timeout']),
    host: takeFlagValue(argv, ['--host']),
    project: takeFlagValue(argv, ['--project']),
    query: takeFlagValue(argv, ['--query', '-q']),
    type: takeFlagValue(argv, ['--type']),
    source: takeFlagValue(argv, ['--source']),
    json: takeFlagBool(argv, ['--json']),
  };
}

async function marketplaceInstall(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const itemId = argv[0];
  if (!itemId || itemId.startsWith('-')) {
    process.stderr.write(
      `${status.err('pass an item id or name: kortix marketplace install kortix-starter:pdf')}\n`,
    );
    return 2;
  }
  const timeout = Number(flags.timeout ?? '300');
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483) {
    process.stderr.write(`${status.err('--timeout must be positive seconds (at most 2147483).')}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  let sessionId: string | undefined;
  let turnId: string | undefined;
  let promptId: string | undefined;
  const finish = (code: number, outcome: string, message: string): number => {
    if (flags.json) emitJson({ outcome, project_id: ctx.projectId, item_id: itemId,
      session_id: sessionId, turn_id: turnId, prompt_id: promptId, message });
    if (code !== 0) process.stderr.write(`${status.err(message)}\n`);
    else if (!flags.json) process.stdout.write(`${status.ok(message)}\n`);
    return code;
  };
  const deadline = Date.now() + timeout * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  const client = createApiClient({ apiBase: ctx.auth.api_base, token: ctx.auth.token, signal: controller.signal });
  try {
    const result = await client.post<{ session_id: string }>(
      `/projects/${ctx.projectId}/marketplace/install-session`, { id: itemId });
    sessionId = result.session_id;
    const base = `/projects/${ctx.projectId}/sessions/${sessionId}`;
    while (!controller.signal.aborted) {
      const session = await client.get<{ status: string; error: string | null }>(base);
      if (session.status === 'failed' || session.status === 'error')
        return finish(1, 'failed', `Install session ${sessionId} failed: ${session.error ?? 'No cause recorded'}. Inspect kortix sessions info ${sessionId}.`);
      const turn = await client.get<{ turns: unknown[]; last_ended?: {
        turn_token: string; end_reason: string | null; error?: { message: string | null; name?: string | null }
      }; recent_failures?: Array<{ message_id: string; error: { message: string | null; name?: string | null } | null }> }>(`${base}/turn`);
      const inbox = await client.get<{ prompts: Array<{ prompt_id: string; state: string; last_error: string | null }> }>(`${base}/prompts`);
      turnId = turn.last_ended?.turn_token;
      const failedPrompt = inbox.prompts.find(p => p.state === 'failed');
      if (failedPrompt) {
        promptId = failedPrompt.prompt_id;
        return finish(1, 'failed', `Install prompt ${promptId} failed: ${failedPrompt.last_error ?? 'No cause recorded'}. Inspect session ${sessionId} and retry the prompt after fixing the cause.`);
      }
      const failure = turn.recent_failures?.[0];
      if (failure || turn.last_ended?.end_reason === 'failed')
        return finish(1, 'failed', `Install turn ${turnId ?? failure?.message_id} failed: ${failure?.error?.message ?? turn.last_ended?.error?.message ?? 'No cause recorded'}. Inspect session ${sessionId} before retrying.`);
      if (turn.turns.length === 0 && inbox.prompts.length === 0 && turn.last_ended) {
        if (turn.last_ended.end_reason === 'completed') {
          try {
            const item = await client.get<{ name: string; type: string; files: Array<{ target: string }> }>(`/marketplace/items/${encodeURIComponent(itemId)}`);
            const targets = item.files.map(f => f.target.replace(/^@(skills|agents|tools|commands)\//, '$1/'));
            const conventional = targets.length > 0 && targets.every(t =>
              !t.startsWith('/') && !t.includes('..') && !t.includes('@') && !t.includes('~'));
            if (item.type === 'registry:skill' && conventional) {
              const detail = await client.get<{ config: { skills: Array<{ name: string }> } }>(`/projects/${ctx.projectId}/detail`);
              let filesPresent = true;
              for (const target of targets) {
                const files = await client.get<Array<{ path: string; type: string }>>(
                  `/projects/${ctx.projectId}/files?path=${encodeURIComponent(target)}`);
                if (!files.some(file => file.path === target && file.type === 'file')) {
                  filesPresent = false;
                  break;
                }
              }
              if (detail.config.skills.some(skill => skill.name === item.name) && filesPresent)
                return finish(0, 'installed', `Installed ${itemId}: skill is configured and all catalog file targets are present on the default branch.`);
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            // Completion is not proof: unavailable catalog/files require review.
          }
        }
        return finish(3, 'awaiting_approval_or_setup', `Install session ${sessionId} ended, but default-branch installation is not proven. Review its change request for approval or finish setup; no change request was merged automatically.`);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('Install deadline elapsed');
  } catch (error) {
    if (controller.signal.aborted) return finish(124, 'timeout',
      `Install timed out after ${timeout}s. Inspect session ${sessionId ?? '(not yet created)'}; the agent may still be running.`);
    return finish(1, 'failed', `Install failed${sessionId ? ` in session ${sessionId}` : ''}: ${error instanceof Error ? error.message : String(error)}. Inspect the session before retrying.`);
  } finally {
    clearTimeout(timer);
  }
}

function resolveMarketplaceClient(host?: string): { client: ApiClient; auth: Auth } | null {
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

function queryString(flags: MarketplaceFlags, query?: string): string {
  const params = new URLSearchParams();
  const q = query ?? flags.query;
  if (q) params.set('query', q);
  if (flags.type) params.set('type', flags.type);
  if (flags.source) params.set('source', flags.source);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

async function fetchItems(flags: MarketplaceFlags, query?: string): Promise<CatalogResponse | null> {
  const ctx = resolveMarketplaceClient(flags.host);
  if (!ctx) return null;
  try {
    return await ctx.client.get<CatalogResponse>(`/marketplace/items${queryString(flags, query)}`);
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
}

function printItems(items: CatalogItem[], flags: MarketplaceFlags): void {
  if (flags.json) {
    emitJson({ items });
    return;
  }
  if (items.length === 0) {
    process.stdout.write(`${status.info('No marketplace items matched.')}\n`);
    return;
  }
  process.stdout.write(`\n  ${C.bold}Marketplace${C.reset} ${C.faded}- ${items.length} item${items.length === 1 ? '' : 's'}${C.reset}\n\n`);
  for (const item of items.slice(0, 40)) {
    const kind = item.type.replace('registry:', '');
    const managed = item.managedBy === 'kortix' ? ` ${C.faded}[Kortix-managed]${C.reset}` : '';
    process.stdout.write(`  ${C.cyan}${item.name}${C.reset} ${C.faded}${kind}${C.reset}${managed}\n`);
    process.stdout.write(`    ${item.title}${item.marketplaceLabel ? C.faded + ` - ${item.marketplaceLabel}` + C.reset : ''}\n`);
    if (item.description) process.stdout.write(`    ${C.dim}${item.description}${C.reset}\n`);
  }
  if (items.length > 40) process.stdout.write(`\n  ${C.dim}Showing 40 of ${items.length}. Narrow with --query.${C.reset}\n`);
  process.stdout.write(`\n  ${C.dim}Show details:${C.reset} ${C.cyan}kortix marketplace show <name>${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Add to a project:${C.reset} ${C.dim}start a session and ask the agent to import it${C.reset}\n`);
}

async function marketplaceSearch(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const query = argv.find((a) => !a.startsWith('-')) ?? flags.query;
  const res = await fetchItems(flags, query);
  if (!res) return 1;
  printItems(res.items ?? [], flags);
  return 0;
}

async function marketplaceShow(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const raw = argv.find((a) => !a.startsWith('-'));
  if (!raw) {
    process.stderr.write(`${status.err('pass an item id or name: kortix marketplace show pdf')}\n`);
    return 2;
  }
  const ctx = resolveMarketplaceClient(flags.host);
  if (!ctx) return 1;

  let item: CatalogItem | null = null;
  try {
    item = await ctx.client.get<CatalogItem>(`/marketplace/items/${encodeURIComponent(raw)}`);
  } catch {
    const searched = await fetchItems(flags, raw);
    item =
      searched?.items.find((i) => i.id === raw) ??
      searched?.items.find((i) => i.name === raw) ??
      searched?.items.find((i) => i.id.endsWith(`:${raw}`)) ??
      (searched?.items.length === 1 ? searched.items[0] : null);
    if (item) {
      try {
        item = await ctx.client.get<CatalogItem>(`/marketplace/items/${encodeURIComponent(item.id)}`);
      } catch {
        // The search result is still useful enough to show.
      }
    }
  }

  if (!item) {
    process.stderr.write(`${status.err(`No marketplace item matches "${raw}".`)}\n`);
    return 1;
  }
  if (flags.json) {
    emitJson(item);
    return 0;
  }

  process.stdout.write(`\n  ${C.bold}${item.title}${C.reset} ${C.faded}(${item.type.replace('registry:', '')})${C.reset}\n`);
  process.stdout.write(`  ${C.dim}${item.id}${C.reset}\n`);
  if (item.description) process.stdout.write(`\n  ${item.description}\n`);
  if (item.categories.length > 0) process.stdout.write(`\n  ${C.dim}Categories:${C.reset} ${item.categories.join(', ')}\n`);
  if (item.dependencies.length > 0) process.stdout.write(`  ${C.dim}Pulls:${C.reset} ${item.dependencies.join(', ')}\n`);
  const secrets = item.capabilities?.secrets ?? [];
  const connectors = item.capabilities?.connectors ?? [];
  if (secrets.length > 0) process.stdout.write(`  ${C.dim}Needs secrets:${C.reset} ${secrets.join(', ')}\n`);
  if (connectors.length > 0) process.stdout.write(`  ${C.dim}Needs connectors:${C.reset} ${connectors.join(', ')}\n`);
  if (item.managedBy === 'kortix') process.stdout.write(`  ${C.dim}Managed by:${C.reset} Kortix (${item.updatePolicy})\n`);
  process.stdout.write(`\n  ${C.dim}Add to a project:${C.reset} ${C.dim}start a session and ask the agent to import "${item.name}"${C.reset}\n`);
  return 0;
}

export async function runMarketplace(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // The root help promises `kortix <cmd> <subcommand> --help`. None of the
  // subcommands below own dedicated help text, so without this a bare
  // `--help` falls through as an ordinary positional arg and the command
  // runs (or fails on auth) instead of printing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  let flags: MarketplaceFlags;
  try { flags = parseFlags(rest); }
  catch (error) {
    process.stderr.write(`${status.err(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }

  switch (sub) {
    case 'search':
    case 'find':
      return marketplaceSearch(rest, flags);
    case 'list':
    case 'ls':
      return marketplaceSearch(rest, flags);
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
