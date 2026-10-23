/**
 * The tools one way to connect an app offers, read before it is installed, so
 * the app page and `kortix connectors catalog show` can say what it can do.
 *
 *   mcp       `mcp-tools.json` (`scripts/probe-one-click-mcp.ts`): a public
 *             server's own `tools/list`, else the Claude directory's names.
 *             An OAuth server lists its tools only after sign-in.
 *   composio  Composio's tool list for the toolkit, live.
 *   openapi   the spec's operations, live, through the connector egress.
 *   graphql, postman, http, cli: nothing to read before install.
 */
import { composioRestClient } from './composio-catalog-search';
import type { ConnectorSurfaceVariant } from './connector-catalog';
import { createConnectorEgressFetch } from './egress';
import mcpTools from './mcp-tools.json';
import { parseSpecDocument } from './spec-doc';

export interface CatalogTool {
  name: string;
  description: string;
}

export interface CatalogTools {
  tools: CatalogTool[];
  /** Every tool the source lists; `tools` holds at most `MAX_TOOLS`. */
  total: number;
  /** Where the list came from. `none`: this way lists nothing before install. */
  source: 'mcp' | 'directory' | 'composio' | 'spec' | 'none';
}

const MAX_TOOLS = 500;
const TTL_MS = 60 * 60_000;
const SPEC_TIMEOUT_MS = 10_000;
const MAX_SPEC_BYTES = 20 * 1024 * 1024;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const SNAPSHOT = mcpTools as unknown as Record<string, [string, string][]>;
// replica-local: a per-process cache of live tool lists; a miss refetches.
const cache = new Map<string, { at: number; value: Promise<CatalogTools> }>();

const capped = (tools: CatalogTool[], source: CatalogTools['source']): CatalogTools => ({
  tools: tools.slice(0, MAX_TOOLS),
  total: tools.length,
  source,
});

function mcpCatalogTools(url: string): CatalogTools {
  const tools = SNAPSHOT[url.trim()] ?? SNAPSHOT[url.trim().replace(/\/+$/, '')] ?? [];
  if (!tools.length) return capped([], 'none');
  const described = tools.some(([, description]) => description);
  return capped(
    tools.map(([name, description]) => ({ name, description })),
    described ? 'mcp' : 'directory',
  );
}

async function composioCatalogTools(toolkit: string): Promise<CatalogTools> {
  const client = composioRestClient() as unknown as {
    tools: {
      list(query: { toolkit_slug: string; limit: number }): Promise<{
        items: { slug?: string; name: string; description?: string }[];
        total_items?: number;
      }>;
    };
  };
  const page = await client.tools.list({ toolkit_slug: toolkit, limit: MAX_TOOLS });
  const tools = page.items.map((tool) => ({
    name: tool.slug ?? tool.name,
    description: (tool.description ?? tool.name ?? '').replace(/\s+/g, ' ').trim(),
  }));
  return { ...capped(tools, 'composio'), total: Math.max(page.total_items ?? 0, tools.length) };
}

/** The operations of an OpenAPI document: `operationId`, else `METHOD /path`. */
export function specOperations(doc: unknown): CatalogTool[] {
  const paths = (doc as { paths?: Record<string, Record<string, unknown>> } | null)?.paths;
  if (!paths || typeof paths !== 'object') return [];
  const tools: CatalogTool[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const op = item[method] as { operationId?: unknown; summary?: unknown; description?: unknown } | undefined;
      if (!op || typeof op !== 'object') continue;
      const text = typeof op.summary === 'string' ? op.summary : typeof op.description === 'string' ? op.description : '';
      tools.push({
        name: typeof op.operationId === 'string' && op.operationId ? op.operationId : `${method.toUpperCase()} ${path}`,
        description: text.replace(/\s+/g, ' ').trim().slice(0, 200),
      });
    }
  }
  return tools;
}

async function specCatalogTools(spec: string): Promise<CatalogTools> {
  const fetchImpl = createConnectorEgressFetch();
  const res = await fetchImpl(spec, {
    method: 'GET',
    headers: { accept: 'application/json, application/yaml, text/yaml, */*' },
    signal: AbortSignal.timeout(SPEC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`spec returned ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_SPEC_BYTES) throw new Error('spec is larger than 20 MB');
  return capped(specOperations(parseSpecDocument(text, spec)), 'spec');
}

function cached(key: string, load: () => Promise<CatalogTools>): Promise<CatalogTools> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  // A failed read is not kept: the next request tries again.
  value.catch(() => cache.get(key)?.value === value && cache.delete(key));
  return value;
}

/** The tools of one way to connect. Throws when a live source cannot be read. */
export function catalogTools(variant: ConnectorSurfaceVariant): Promise<CatalogTools> {
  if (variant.kind === 'mcp' && variant.url) return Promise.resolve(mcpCatalogTools(variant.url));
  if (variant.kind === 'composio' && variant.composio) {
    const toolkit = variant.composio.slug;
    return cached(`composio:${toolkit}`, () => composioCatalogTools(toolkit));
  }
  const spec = variant.kind === 'openapi' ? variant.connector?.spec : undefined;
  if (spec) return cached(`spec:${spec}`, () => specCatalogTools(spec));
  return Promise.resolve(capped([], 'none'));
}
