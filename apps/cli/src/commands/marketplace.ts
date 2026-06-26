/**
 * `kortix marketplace <subcommand>` - browse and install from the Kortix
 * marketplace. This is intentionally a consumer surface only: no build,
 * validate, or publish commands live here.
 */

import { loadAuth, loadAuthForHost, type Auth } from '../api/auth.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { emitJson, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, status } from '../style.ts';
import { runMarketplaceInstall } from './marketplace-install.ts';

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

interface InstalledResponse {
  installed: Array<{
    name: string;
    type: string;
    source: string;
    installed_at: string | null;
    file_count: number;
  }>;
}

interface UpdatesResponse {
  updates: Array<{ name: string; type: string; status: string; changed: number }>;
  update_available: string[];
}

interface WriteResponse {
  ok: boolean;
  commit_sha: string;
  branch: string;
  file_count: number;
  updated?: string;
  removed?: string;
}

interface MarketplaceFlags {
  host?: string;
  query?: string;
  type?: string;
  source?: string;
  project?: string;
  json: boolean;
  dryRun: boolean;
}

const HELP = `Usage: kortix marketplace <subcommand> [options]

Browse and install items from the Kortix marketplace.

Subcommands:
  search [query]       Search marketplace items.
  list                 List marketplace items.
  show <id|name>       Show one marketplace item.
  install <id|name>    Install into a linked cloud project.
  status               List installed marketplace items for a project.
  updates              List installed items with available updates.
  update <name>        Update one installed marketplace item.
  remove <name>        Remove one installed marketplace item.

Options:
  --query <text>       Search text (same as search [query]).
  --type <type>        Filter by item type, e.g. skill.
  --source <source>    Filter by marketplace/source, e.g. kortix.
  --project <id>       Project for install/status/update/remove.
  --host <name>        Use a configured Kortix host.
  --dry-run            install: show what would be installed.
  --json               Machine-readable output.
  -h, --help           Show this help.
`;

function parseFlags(argv: string[]): MarketplaceFlags {
  return {
    host: takeFlagValue(argv, ['--host']),
    query: takeFlagValue(argv, ['--query', '-q']),
    type: takeFlagValue(argv, ['--type']),
    source: takeFlagValue(argv, ['--source']),
    project: takeFlagValue(argv, ['--project']),
    dryRun: takeFlagBool(argv, ['--dry-run']),
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
  process.stdout.write(`  ${C.dim}Install:${C.reset} ${C.cyan}kortix marketplace install <name> --project <id>${C.reset}\n`);
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
  process.stdout.write(`\n  ${C.dim}Install:${C.reset} ${C.cyan}kortix marketplace install ${item.name} --project <id>${C.reset}\n`);
  return 0;
}

async function marketplaceInstall(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const raw = argv.find((a) => !a.startsWith('-'));
  if (!raw) {
    process.stderr.write(`${status.err('pass an item id or name: kortix marketplace install pdf')}\n`);
    return 2;
  }
  const addArgs = [raw];
  if (flags.project) addArgs.push('--project', flags.project);
  if (flags.host) addArgs.push('--host', flags.host);
  if (flags.dryRun) addArgs.push('--dry-run');
  if (flags.json) addArgs.push('--json');
  return runMarketplaceInstall(addArgs);
}

async function marketplaceStatus(flags: MarketplaceFlags): Promise<number> {
  const ctx = resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  let res: InstalledResponse;
  try {
    res = await ctx.client.get<InstalledResponse>(`/projects/${ctx.projectId}/marketplace`);
  } catch (err) {
    return surfaceApiError(err);
  }
  const installed = res.installed ?? [];
  if (flags.json) {
    emitJson({ installed });
    return 0;
  }
  if (installed.length === 0) {
    process.stdout.write(`${status.info('No marketplace items installed in this project.')}\n`);
    process.stdout.write(`  ${C.dim}Add one with${C.reset} ${C.cyan}kortix marketplace install <item> --project ${ctx.projectId}${C.reset}\n`);
    return 0;
  }
  process.stdout.write(`\n  ${C.bold}Installed${C.reset} ${C.faded}- ${installed.length} item${installed.length === 1 ? '' : 's'}${C.reset}\n\n`);
  const width = Math.min(26, Math.max(...installed.map((i) => i.name.length)));
  for (const item of installed) {
    const kind = item.type.replace('registry:', '');
    process.stdout.write(
      `  ${C.cyan}${item.name.padEnd(width)}${C.reset}  ${C.faded}${kind.padEnd(8)}${C.reset}  ${C.dim}${item.source}${C.reset}\n`,
    );
  }
  return 0;
}

async function marketplaceUpdates(flags: MarketplaceFlags): Promise<number> {
  const ctx = resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  let res: UpdatesResponse;
  try {
    res = await ctx.client.get<UpdatesResponse>(`/projects/${ctx.projectId}/marketplace/updates`);
  } catch (err) {
    return surfaceApiError(err);
  }
  if (flags.json) {
    emitJson(res);
    return 0;
  }
  const updates = res.updates ?? [];
  if (updates.length === 0) {
    process.stdout.write(`${status.info('No marketplace items installed in this project.')}\n`);
    return 0;
  }
  process.stdout.write(`\n  ${C.bold}Marketplace Updates${C.reset}\n\n`);
  for (const item of updates) {
    const color = item.status === 'update-available' ? C.yellow : C.faded;
    process.stdout.write(`  ${C.cyan}${item.name}${C.reset}  ${color}${item.status}${C.reset}`);
    if (item.changed > 0) process.stdout.write(` ${C.dim}(${item.changed} changes)${C.reset}`);
    process.stdout.write('\n');
  }
  return 0;
}

async function marketplaceUpdate(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) {
    process.stderr.write(`${status.err('pass an item name: kortix marketplace update pdf')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  let res: WriteResponse;
  try {
    res = await ctx.client.post<WriteResponse>(`/projects/${ctx.projectId}/marketplace/update`, { name });
  } catch (err) {
    return surfaceApiError(err);
  }
  if (flags.json) {
    emitJson(res);
    return 0;
  }
  process.stdout.write(`${status.ok(`Updated ${C.bold}${res.updated ?? name}${C.reset}`)}\n`);
  process.stdout.write(`  ${C.dim}commit${C.reset} ${C.cyan}${res.commit_sha?.slice(0, 8)}${C.reset} ${C.dim}on${C.reset} ${res.branch}\n`);
  return 0;
}

async function marketplaceRemove(argv: string[], flags: MarketplaceFlags): Promise<number> {
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) {
    process.stderr.write(`${status.err('pass an item name: kortix marketplace remove pdf')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  let res: WriteResponse;
  try {
    res = await ctx.client.delete<WriteResponse>(`/projects/${ctx.projectId}/marketplace/${encodeURIComponent(name)}`);
  } catch (err) {
    return surfaceApiError(err);
  }
  if (flags.json) {
    emitJson(res);
    return 0;
  }
  process.stdout.write(`${status.ok(`Removed ${C.bold}${res.removed ?? name}${C.reset}`)}\n`);
  process.stdout.write(`  ${C.dim}commit${C.reset} ${C.cyan}${res.commit_sha?.slice(0, 8)}${C.reset} ${C.dim}on${C.reset} ${res.branch}\n`);
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
    case 'install':
    case 'add':
      return marketplaceInstall(rest, flags);
    case 'status':
    case 'installed':
      return marketplaceStatus(flags);
    case 'updates':
    case 'outdated':
      return marketplaceUpdates(flags);
    case 'update':
      return marketplaceUpdate(rest, flags);
    case 'remove':
    case 'rm':
      return marketplaceRemove(rest, flags);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}
