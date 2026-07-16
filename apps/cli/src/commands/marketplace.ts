/**
 * `kortix marketplace <subcommand>` - browse the Kortix marketplace. This is
 * intentionally a discovery-only surface: no build, validate, or publish
 * commands live here, and no deterministic install/update/remove machinery
 * either — adding a marketplace item to a project is an agent import
 * (start/continue a session and ask it to bring the item in), not a CLI
 * write path.
 */

import { loadAuth, loadAuthForHost, type Auth } from '../api/auth.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { emitJson, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
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
  query?: string;
  type?: string;
  source?: string;
  json: boolean;
}

const HELP = help`Usage: kortix marketplace <subcommand> [options]

Browse the Kortix marketplace.

Subcommands:
  search [query]       Search marketplace items.
  list                 List marketplace items.
  show <id|name>       Show one marketplace item.

Options:
  --query <text>       Search text (same as search [query]).
  --type <type>        Filter by item type, e.g. skill.
  --source <source>    Filter by marketplace/source, e.g. kortix.
  --host <name>        Use a configured Kortix host.
  --json               Machine-readable output.
  -h, --help           Show this help.

Adding an item to your project is an agent import, not a CLI install: start
or continue a session and ask it to bring the item in (it clones, reads,
merges what fits, and opens a CR).
`;

function parseFlags(argv: string[]): MarketplaceFlags {
  return {
    host: takeFlagValue(argv, ['--host']),
    query: takeFlagValue(argv, ['--query', '-q']),
    type: takeFlagValue(argv, ['--type']),
    source: takeFlagValue(argv, ['--source']),
    json: takeFlagBool(argv, ['--json']),
  };
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
  const flags = parseFlags(rest);

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
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}
