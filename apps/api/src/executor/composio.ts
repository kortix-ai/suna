import { Composio } from '@composio/core';
import { config } from '../config';

const PAGE_SIZE = 48;

export interface ComposioToolkitView {
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  authRequired: boolean;
  toolsCount: number | null;
  categories: string[];
  mcpUrl: string | null;
}

export interface ComposioToolView {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string;
  authRequired: boolean;
}

export interface ComposioToolkitsPage {
  toolkits: ComposioToolkitView[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface ComposioToolsPage {
  tools: ComposioToolView[];
  nextCursor?: string;
  hasMore: boolean;
}

interface ToolkitPageParams {
  managed_by: 'all' | 'composio' | 'project';
  sort_by: 'usage' | 'alphabetically';
  limit: number;
  search?: string;
  cursor?: string;
}

interface ToolPageParams {
  toolkit_slug: string;
  toolkit_versions: 'latest';
  limit: number;
  query?: string;
  cursor?: string;
}

interface ComposioCatalogueClient {
  listToolkitPage(params: ToolkitPageParams): Promise<unknown>;
  listToolPage(params: ToolPageParams): Promise<unknown>;
}

interface ComposioSessionLike {
  sessionId: string;
  mcp: {
    url: string;
    headers?: Record<string, string>;
  };
  toolkits(input: { toolkits: string[]; limit: number }): Promise<unknown>;
  authorize(toolkitSlug: string, options: { callbackUrl: string }): Promise<unknown>;
  delete(): Promise<unknown>;
}

interface ComposioSessionClient {
  create(userId: string, input: Record<string, unknown>): Promise<ComposioSessionLike>;
  use(sessionId: string, options: { mcp: true }): Promise<ComposioSessionLike>;
}

export interface ComposioToolkitSession {
  sessionId: string;
  mcpUrl: string;
  credentialHeaderName: 'x-api-key';
  requiresAuthorization: boolean;
}

class PaginatedComposio extends Composio implements ComposioCatalogueClient {
  async listToolkitPage(params: ToolkitPageParams): Promise<unknown> {
    return await this.client.toolkits.list(params);
  }

  async listToolPage(params: ToolPageParams): Promise<unknown> {
    return await this.client.tools.list(params);
  }
}

let client: ComposioCatalogueClient | null = null;

export function composioConfigured(): boolean {
  return Boolean(config.COMPOSIO_API_KEY) && config.COMPOSIO_ENABLED !== false;
}

function composioClient(): ComposioCatalogueClient {
  if (!config.COMPOSIO_API_KEY) {
    throw new Error('Composio is not configured');
  }
  client ??= new PaginatedComposio({ apiKey: config.COMPOSIO_API_KEY });
  return client;
}

function composioSessionClient(): ComposioSessionClient {
  return composioClient() as unknown as ComposioSessionClient;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pageItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const page = asRecord(value);
  if (Array.isArray(page.items)) return page.items;
  if (Array.isArray(page.data)) return page.data;
  if (Array.isArray(page.results)) return page.results;
  return [];
}

function nextCursor(value: unknown): string | undefined {
  const page = asRecord(value);
  return (
    stringValue(page.nextCursor) ??
    stringValue(page.next_cursor) ??
    stringValue(page.cursor) ??
    undefined
  );
}

function toolkitCategories(item: Record<string, unknown>, meta: Record<string, unknown>): string[] {
  const categories = Array.isArray(meta.categories)
    ? meta.categories
    : Array.isArray(item.categories)
      ? item.categories
      : [];
  return categories
    .map((category) => {
      if (typeof category === 'string') return category;
      const record = asRecord(category);
      return stringValue(record.name) ?? stringValue(record.slug);
    })
    .filter((category): category is string => Boolean(category));
}

function toolkitAuthRequired(item: Record<string, unknown>): boolean {
  if (typeof item.noAuth === 'boolean') return !item.noAuth;
  if (typeof item.no_auth === 'boolean') return !item.no_auth;
  if (typeof item.isNoAuth === 'boolean') return !item.isNoAuth;
  return true;
}

function normalizeToolkit(itemValue: unknown): ComposioToolkitView | null {
  const item = asRecord(itemValue);
  const meta = asRecord(item.meta);
  const slug = stringValue(item.slug);
  const name = stringValue(item.name) ?? slug;
  if (!slug || !name) return null;
  return {
    slug,
    name,
    description: stringValue(meta.description) ?? stringValue(item.description),
    iconUrl: stringValue(meta.logo) ?? stringValue(item.logo) ?? stringValue(item.iconUrl),
    authRequired: toolkitAuthRequired(item),
    toolsCount:
      numberValue(meta.toolsCount) ??
      numberValue(meta.tools_count) ??
      numberValue(item.toolsCount) ??
      numberValue(item.tools_count),
    categories: toolkitCategories(item, meta),
    mcpUrl: stringValue(item.mcpUrl) ?? stringValue(item.mcp_url),
  };
}

function normalizeTool(itemValue: unknown, toolkitSlug: string): ComposioToolView | null {
  const item = asRecord(itemValue);
  const toolkit = asRecord(item.toolkit);
  const slug = stringValue(item.slug);
  const name = stringValue(item.name) ?? slug;
  if (!slug || !name) return null;
  return {
    slug,
    name,
    description: stringValue(item.description),
    toolkitSlug: stringValue(toolkit.slug) ?? toolkitSlug,
    authRequired:
      typeof item.isNoAuth === 'boolean'
        ? !item.isNoAuth
        : typeof item.is_no_auth === 'boolean'
          ? !item.is_no_auth
          : typeof item.no_auth === 'boolean'
            ? !item.no_auth
            : true,
  };
}

function matchesToolkitQuery(toolkit: ComposioToolkitView, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    toolkit.name.toLowerCase().includes(needle) ||
    toolkit.slug.toLowerCase().includes(needle) ||
    (toolkit.description ?? '').toLowerCase().includes(needle) ||
    toolkit.categories.some((category) => category.toLowerCase().includes(needle))
  );
}

export async function listComposioToolkits(
  input: {
    q?: string;
    cursor?: string;
  },
  catalogue: ComposioCatalogueClient = composioClient(),
): Promise<ComposioToolkitsPage> {
  const query = input.q?.trim() || undefined;
  const upstreamQuery = query && query.length >= 3 ? query : undefined;
  const response = await catalogue.listToolkitPage({
    managed_by: 'all',
    sort_by: 'usage',
    limit: PAGE_SIZE,
    ...(upstreamQuery ? { search: upstreamQuery } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  let toolkits = pageItems(response)
    .map(normalizeToolkit)
    .filter((toolkit): toolkit is ComposioToolkitView => Boolean(toolkit));
  if (query && !upstreamQuery) {
    toolkits = toolkits.filter((toolkit) => matchesToolkitQuery(toolkit, query));
  }
  const cursor = nextCursor(response);
  return { toolkits, nextCursor: cursor, hasMore: Boolean(cursor) };
}

export async function listComposioTools(
  input: {
    toolkitSlug: string;
    q?: string;
    cursor?: string;
  },
  catalogue: ComposioCatalogueClient = composioClient(),
): Promise<ComposioToolsPage> {
  const response = await catalogue.listToolPage({
    toolkit_slug: input.toolkitSlug,
    toolkit_versions: 'latest',
    limit: PAGE_SIZE,
    ...(input.q ? { query: input.q } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  const tools = pageItems(response)
    .map((item) => normalizeTool(item, input.toolkitSlug))
    .filter((tool): tool is ComposioToolView => Boolean(tool));
  const cursor = nextCursor(response);
  return { tools, nextCursor: cursor, hasMore: Boolean(cursor) };
}

export async function createComposioToolkitSession(
  input: { projectId: string; toolkitSlug: string; callbackUrl: string },
  sessionClient: ComposioSessionClient = composioSessionClient(),
): Promise<ComposioToolkitSession> {
  const session = await sessionClient.create(`kortix-project-${input.projectId}`, {
    toolkits: [input.toolkitSlug],
    preload: { tools: 'all' },
    manageConnections: {
      enable: true,
      callbackUrl: input.callbackUrl,
      waitForConnections: false,
    },
    sandbox: { enable: false },
    mcp: true,
  });

  try {
    const toolkitPage = asRecord(
      await session.toolkits({ toolkits: [input.toolkitSlug], limit: 1 }),
    );
    const toolkit = asRecord((Array.isArray(toolkitPage.items) ? toolkitPage.items : [])[0]);
    if (!stringValue(toolkit.slug)) throw new Error('Composio toolkit is unavailable');

    const mcpUrl = stringValue(session.mcp?.url);
    const credentialHeaderName = Object.keys(session.mcp?.headers ?? {}).find(
      (name) => name.toLowerCase() === 'x-api-key',
    );
    if (!mcpUrl || !credentialHeaderName) {
      throw new Error('Composio did not return an authenticated MCP endpoint');
    }

    const connection = asRecord(toolkit.connection);
    return {
      sessionId: session.sessionId,
      mcpUrl,
      credentialHeaderName: 'x-api-key',
      requiresAuthorization: toolkit.isNoAuth !== true && connection.isActive !== true,
    };
  } catch (error) {
    await session.delete().catch(() => undefined);
    throw error;
  }
}

export async function authorizeComposioToolkitSession(
  input: { sessionId: string; toolkitSlug: string; callbackUrl: string },
  sessionClient: ComposioSessionClient = composioSessionClient(),
): Promise<string> {
  const session = await sessionClient.use(input.sessionId, { mcp: true });
  const request = asRecord(
    await session.authorize(input.toolkitSlug, {
      callbackUrl: input.callbackUrl,
    }),
  );
  const redirectUrl = stringValue(request.redirectUrl);
  if (!redirectUrl) throw new Error('Composio did not return an authorization URL');
  return redirectUrl;
}

export async function deleteComposioSession(
  sessionId: string,
  sessionClient: ComposioSessionClient = composioSessionClient(),
): Promise<void> {
  const session = await sessionClient.use(sessionId, { mcp: true });
  await session.delete();
}
