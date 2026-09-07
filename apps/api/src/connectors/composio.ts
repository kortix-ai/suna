import {
  Composio,
  type ToolRouterCreateSessionConfig,
  type ToolRouterSessionExecuteResponse,
  type ToolkitConnectionsDetails,
} from '@composio/core';
import ComposioClient from '@composio/client';
import { HTTPException } from 'hono/http-exception';
import type { ExecResult } from './call';
import type { ComposioToolLike } from './types';

interface ComposioConnectionRequestLike {
  id: string;
  status?: string;
  redirectUrl?: string | null;
  toJSON?: () => {
    id: string;
    status?: string;
    redirectUrl?: string | null;
  };
}

export interface ComposioRuntime {
  sessions: {
    create(userId: string, config?: ToolRouterCreateSessionConfig): Promise<ComposioSessionLike>;
    use(sessionId: string): Promise<ComposioSessionLike>;
  };
  toolkits?: {
    get(query: { category?: string; limit?: number }): Promise<
      Array<{
        slug: string;
        name: string;
        noAuth?: boolean;
        meta: {
          logo?: string | null;
          description?: string | null;
          categories?: Array<{ slug: string; name: string }>;
        };
      }>
    >;
  };
}

export interface ComposioSessionLike {
  sessionId: string;
  tools(): Promise<ComposioToolLike[]>;
  toolkits(options?: {
    toolkits?: string[];
    cursor?: string;
    limit?: number;
    isConnected?: boolean;
    search?: string;
  }): Promise<ToolkitConnectionsDetails>;
  authorize(
    toolkit: string,
    options?: { callbackUrl?: string; alias?: string },
  ): Promise<ComposioConnectionRequestLike>;
  execute(
    toolSlug: string,
    args?: Record<string, unknown>,
    options?: { account?: string },
  ): Promise<ToolRouterSessionExecuteResponse>;
}

export interface ComposioExecuteInput {
  projectId: string;
  connectorSlug: string;
  connectionId: string;
  sessionId?: string | null;
  toolkit: string;
  toolSlug: string;
  args: Record<string, unknown>;
  connectedAccountId: string | null;
}

export interface ComposioConnectResult {
  connectUrl?: string;
  sessionId: string;
  authRequestId?: string;
  connectedAccountId?: string;
  connected: boolean;
  isNoAuth: boolean;
}

export interface ComposioFinalizeResult {
  connected: boolean;
  connectedAccountId?: string;
  sessionId: string;
  authRequestId?: string;
  isNoAuth: boolean;
}

let runtime: ComposioRuntime | null = null;
let catalogClient: ComposioCatalogClient | null = null;

export function composioConfigured(): boolean {
  return !!process.env.COMPOSIO_API_KEY;
}

export function composioUserId(connectionId: string): string {
  const id = connectionId.trim();
  if (!id) throw new Error('composio connection id is required');
  return `kortix-connection:${id}`;
}

function assertStableUserId(connectionId: string, stableUserId: string): void {
  if (stableUserId !== composioUserId(connectionId)) {
    throw new Error('composio stable user id must match the selected connection');
  }
}

export function getComposioRuntime(): ComposioRuntime {
  if (!composioConfigured()) throw new Error('Composio is not configured (set COMPOSIO_API_KEY)');
  if (!runtime) {
    runtime = new Composio({
      apiKey: process.env.COMPOSIO_API_KEY,
      allowTracking: false,
      dangerouslyAllowAutoUploadDownloadFiles: false,
    }) as unknown as ComposioRuntime;
  }
  return runtime;
}

function getComposioCatalogClient(): ComposioCatalogClient {
  if (!composioConfigured()) throw new Error('Composio is not configured (set COMPOSIO_API_KEY)');
  if (!catalogClient) {
    catalogClient = new ComposioClient({
      apiKey: process.env.COMPOSIO_API_KEY,
    }) as ComposioCatalogClient;
  }
  return catalogClient;
}

export function setComposioRuntimeForTest(next: ComposioRuntime | null): void {
  runtime = next;
  if (next === null) catalogClient = null;
}

function directSessionConfig(toolkit: string, connectedAccountId?: string | null): ToolRouterCreateSessionConfig {
  return {
    sessionPreset: 'direct_tools',
    toolkits: [toolkit],
    manageConnections: false,
    sandbox: { enable: false },
    ...(connectedAccountId ? { connectedAccounts: { [toolkit]: connectedAccountId } } : {}),
  };
}

async function useOrCreateSession(input: {
  runtime: ComposioRuntime;
  connectionId: string;
  sessionId?: string | null;
  toolkit: string;
  connectedAccountId?: string | null;
}): Promise<ComposioSessionLike> {
  if (input.sessionId) return input.runtime.sessions.use(input.sessionId);
  return input.runtime.sessions.create(
    composioUserId(input.connectionId),
    directSessionConfig(input.toolkit, input.connectedAccountId),
  );
}

function toolkitState(page: ToolkitConnectionsDetails, toolkit: string) {
  return page.items.find((item) => item.slug.toLowerCase() === toolkit.toLowerCase());
}

async function loadToolkitState(session: ComposioSessionLike, toolkit: string) {
  const page = await session.toolkits({ toolkits: [toolkit], limit: 1 });
  const state = toolkitState(page, toolkit);
  if (!state) throw new Error(`composio toolkit not found: ${toolkit}`);
  return state;
}

function activeConnectedAccountId(
  state: Awaited<ReturnType<typeof loadToolkitState>>,
): string | undefined {
  return state.connection?.isActive === true ? state.connection.connectedAccount?.id : undefined;
}

interface ComposioCatalogToolkit {
  slug: string;
  name: string;
  no_auth?: boolean;
  meta: {
    logo?: string | null;
    description?: string | null;
    categories?: Array<{ id: string; name: string }>;
  };
}

interface ComposioCatalogPage {
  items: ComposioCatalogToolkit[];
  next_cursor?: string | null;
}

export interface ComposioCatalogClient {
  toolkits: {
    list(query: {
      limit: number;
      sort_by: 'usage';
      cursor?: string;
    }): Promise<ComposioCatalogPage>;
  };
}

export interface ComposioCatalogEntry {
  slug: string;
  name: string;
  logo: string | null;
  description: string | null;
  categories: string[];
  isNoAuth: boolean;
  connected: false;
}

export interface ComposioCatalogCategory {
  key: string;
  label: string;
  count: number;
}

interface ComposioCatalogSnapshot {
  toolkits: ComposioCatalogEntry[];
  categoryLabels: Map<string, string>;
}

const COMPOSIO_CATALOG_TTL_MS = 6 * 60 * 60_000;
const TEAM_CHAT_CATEGORY = 'team-chat';
const catalogCache = new WeakMap<
  ComposioCatalogClient,
  { at: number; snapshot: Promise<ComposioCatalogSnapshot> }
>();

function normalizeCatalogToolkit(toolkit: ComposioCatalogToolkit): ComposioCatalogEntry {
  return {
    slug: toolkit.slug,
    name: toolkit.name,
    logo: toolkit.meta.logo ?? null,
    description: toolkit.meta.description ?? null,
    categories: (toolkit.meta.categories ?? []).map((category) => category.id),
    isNoAuth: toolkit.no_auth === true,
    connected: false,
  };
}

async function buildCatalogSnapshot(
  client: ComposioCatalogClient,
): Promise<ComposioCatalogSnapshot> {
  const raw: ComposioCatalogToolkit[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.toolkits.list({
      limit: 1000,
      sort_by: 'usage',
      ...(cursor ? { cursor } : {}),
    });
    raw.push(...page.items);
    const next = page.next_cursor?.trim() || undefined;
    if (next && cursors.has(next)) throw new Error('Composio toolkit catalogue repeated a cursor');
    if (next) cursors.add(next);
    cursor = next;
  } while (cursor);

  const categoryLabels = new Map<string, string>();
  const seen = new Set<string>();
  const toolkits: ComposioCatalogEntry[] = [];
  for (const toolkit of raw) {
    const categories = toolkit.meta.categories ?? [];
    if (categories.some((category) => category.id.toLowerCase() === TEAM_CHAT_CATEGORY)) continue;
    const slug = toolkit.slug.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    for (const category of categories) categoryLabels.set(category.id, category.name);
    toolkits.push(normalizeCatalogToolkit(toolkit));
  }
  return { toolkits, categoryLabels };
}

async function composioCatalogSnapshot(
  client: ComposioCatalogClient,
): Promise<ComposioCatalogSnapshot> {
  const cached = catalogCache.get(client);
  if (cached && Date.now() - cached.at < COMPOSIO_CATALOG_TTL_MS) return cached.snapshot;
  const snapshot = buildCatalogSnapshot(client);
  catalogCache.set(client, { at: Date.now(), snapshot });
  try {
    return await snapshot;
  } catch (error) {
    catalogCache.delete(client);
    throw error;
  }
}

function catalogCursor(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url');
}

function catalogOffset(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const value = Buffer.from(cursor, 'base64url').toString('utf8');
    return /^\d+$/.test(value) ? Number(value) : 0;
  } catch {
    return 0;
  }
}

function filterCatalog(toolkits: ComposioCatalogEntry[], input: { q?: string; category?: string }) {
  const query = input.q?.trim().toLowerCase();
  const category = input.category?.trim().toLowerCase();
  return toolkits.filter((toolkit) => {
    if (category && !toolkit.categories.some((item) => item.toLowerCase() === category))
      return false;
    return (
      !query ||
      `${toolkit.name} ${toolkit.slug} ${toolkit.description ?? ''}`.toLowerCase().includes(query)
    );
  });
}

export async function composioCatalogPage(input: {
  projectId: string;
  q?: string;
  category?: string;
  cursor?: string;
  limit?: number;
  runtime?: ComposioRuntime;
  catalogClient?: ComposioCatalogClient;
}): Promise<{
  provider: 'composio';
  toolkits: ComposioCatalogEntry[];
  total: number;
  nextCursor?: string;
  hasMore: boolean;
}> {
  const snapshot = await composioCatalogSnapshot(input.catalogClient ?? getComposioCatalogClient());
  const matches = filterCatalog(snapshot.toolkits, input);
  const limit = Math.min(Math.max(input.limit ?? 48, 1), 100);
  const offset = Math.min(catalogOffset(input.cursor), matches.length);
  const nextOffset = offset + limit;
  const hasMore = nextOffset < matches.length;
  return {
    provider: 'composio',
    toolkits: matches.slice(offset, nextOffset),
    total: matches.length,
    ...(hasMore ? { nextCursor: catalogCursor(nextOffset) } : {}),
    hasMore,
  };
}

export async function composioCatalogSections(
  input: {
    perCategory?: number;
    maxCategories?: number;
    catalogClient?: ComposioCatalogClient;
  } = {},
): Promise<{
  sections: Array<{ key: string; label: string; total: number; toolkits: ComposioCatalogEntry[] }>;
  categories: ComposioCatalogCategory[];
}> {
  const snapshot = await composioCatalogSnapshot(input.catalogClient ?? getComposioCatalogClient());
  const buckets = new Map<string, ComposioCatalogEntry[]>();
  for (const toolkit of snapshot.toolkits) {
    for (const category of toolkit.categories) {
      const bucket = buckets.get(category) ?? [];
      bucket.push(toolkit);
      buckets.set(category, bucket);
    }
  }
  const categories = [...buckets.entries()]
    .map(([key, toolkits]) => ({
      key,
      label: snapshot.categoryLabels.get(key) ?? key,
      count: toolkits.length,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  const perCategory = Math.min(Math.max(input.perCategory ?? 6, 1), 100);
  const maxCategories = Math.min(Math.max(input.maxCategories ?? 12, 1), 100);
  return {
    sections: categories.slice(0, maxCategories).map((category) => ({
      key: category.key,
      label: category.label,
      total: category.count,
      toolkits: (buckets.get(category.key) ?? []).slice(0, perCategory),
    })),
    categories,
  };
}

/** Fetch public tool schemas without creating a connection-scoped auth identity. */
export async function composioCatalogTools(input: {
  projectId: string;
  connectorSlug: string;
  toolkit: string;
  runtime?: ComposioRuntime;
}): Promise<ComposioToolLike[]> {
  const session = await (input.runtime ?? getComposioRuntime()).sessions.create(
    `kortix-catalog:${input.projectId}:${input.connectorSlug}`,
    directSessionConfig(input.toolkit),
  );
  return session.tools();
}

export async function composioSessionTools(input: {
  connectionId: string;
  toolkit: string;
  sessionId?: string | null;
  connectedAccountId?: string | null;
  runtime?: ComposioRuntime;
}): Promise<ComposioToolLike[]> {
  const session = await useOrCreateSession({
    runtime: input.runtime ?? getComposioRuntime(),
    connectionId: input.connectionId,
    sessionId: input.sessionId,
    toolkit: input.toolkit,
    connectedAccountId: input.connectedAccountId,
  });
  return session.tools();
}

export async function executeComposio(
  input: ComposioExecuteInput & { runtime?: ComposioRuntime },
): Promise<ExecResult> {
  const session = await useOrCreateSession({
    runtime: input.runtime ?? getComposioRuntime(),
    connectionId: input.connectionId,
    sessionId: input.sessionId,
    toolkit: input.toolkit,
    connectedAccountId: input.connectedAccountId,
  });
  const state = await loadToolkitState(session, input.toolkit);
  const activeAccountId = activeConnectedAccountId(state);

  if (!state.isNoAuth) {
    if (!input.connectedAccountId || !activeAccountId) {
      throw new Error('composio_connection_not_active');
    }
    if (activeAccountId !== input.connectedAccountId) {
      throw new Error('composio_connected_account_mismatch');
    }
  }

  // The resumed Tool Router session already owns the toolkit → connected-account
  // binding, and the state check above proves it is the expected account. Passing
  // `options.account` again opts into Composio's multi-account selector, which is
  // rejected (code 4300) on ordinary single-account projects.
  const response = await session.execute(input.toolSlug, input.args);
  const logId = typeof response.logId === 'string' ? response.logId.trim() : '';
  if (!logId) throw new Error('composio execution returned no log id');

  const data = {
    provider: 'composio',
    requestId: logId,
    logId,
    sessionId: session.sessionId,
    result: response.data,
    ...(response.error ? { error: response.error } : {}),
  };
  return response.error ? { ok: false, status: 502, data } : { ok: true, status: 200, data };
}

/** Composio's `ConnectedAccount_BadRequest` for a reused alias. */
function isAliasConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /alias .*already in use/i.test(message);
}

/**
 * `session.authorize` with the connector slug as the connected-account alias,
 * retried once under a fresh alias when Composio refuses the slug.
 *
 * Incident 2026-09-03 (local dev, GitHub): an earlier Connect attempt left a
 * non-ACTIVE connected account aliased `github` on this entity. Nothing above
 * treats that as connected (`activeConnectedAccountId` wants `isActive`), so
 * the next Connect re-authorized under the same alias and Composio answered
 * 400 "Alias \"github\" is already in use by another connection for this
 * entity" — which the API surfaced as an opaque 500. The alias is a label on
 * Composio's side only (finalize binds through `session.toolkits()`, never
 * by alias), so a suffixed alias loses nothing. Any other refusal is
 * re-thrown as a 502 carrying Composio's message, not a 500 hiding it.
 */
async function authorizeWithFreshAlias(
  session: ComposioSessionLike,
  toolkit: string,
  slug: string,
  callbackUrl: string | undefined,
): Promise<ComposioConnectionRequestLike> {
  const base = callbackUrl ? { callbackUrl } : {};
  try {
    return await session.authorize(toolkit, { ...base, alias: slug });
  } catch (error) {
    if (!isAliasConflict(error)) throw upstreamRefusal(error);
    try {
      return await session.authorize(toolkit, {
        ...base,
        alias: `${slug}-${Date.now().toString(36)}`,
      });
    } catch (retryError) {
      throw upstreamRefusal(retryError);
    }
  }
}

function upstreamRefusal(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new HTTPException(502, {
    message: `Composio refused the authorization: ${message.split('\n')[0]}`,
  });
}

export async function composioConnectUrl(input: {
  projectId: string;
  slug: string;
  app: string;
  connectionId: string;
  stableUserId: string;
  redirects?: { success?: string; error?: string };
  runtime?: ComposioRuntime;
}): Promise<ComposioConnectResult> {
  assertStableUserId(input.connectionId, input.stableUserId);
  const runtime = input.runtime ?? getComposioRuntime();
  const session = await runtime.sessions.create(
    input.stableUserId,
    // Leave authConfigs unset. Composio's managed app is the supported
    // zero-setup path. Custom OAuth scopes require a verified app owned by the
    // customer and must not be smuggled into the managed client.
    directSessionConfig(input.app),
  );
  const state = await loadToolkitState(session, input.app);
  if (state.isNoAuth) {
    return {
      sessionId: session.sessionId,
      connected: true,
      isNoAuth: true,
    };
  }

  const existingAccountId = activeConnectedAccountId(state);
  if (existingAccountId) {
    return {
      sessionId: session.sessionId,
      connectedAccountId: existingAccountId,
      connected: true,
      isNoAuth: false,
    };
  }

  const request = await authorizeWithFreshAlias(session, input.app, input.slug, input.redirects?.success);
  const requestState = request.toJSON ? request.toJSON() : request;
  const connectUrl = requestState.redirectUrl ?? '';
  if (!connectUrl) throw new Error('composio authorize returned no redirect url');

  // `authorize().id` identifies the authorization request. It is not trusted as
  // the connected-account id. Only `session.toolkits()` supplies that binding.
  const postAuthorizeState = await loadToolkitState(session, input.app);
  const connectedAccountId = activeConnectedAccountId(postAuthorizeState);
  return {
    connectUrl,
    sessionId: session.sessionId,
    authRequestId: requestState.id,
    ...(connectedAccountId ? { connectedAccountId } : {}),
    connected: !!connectedAccountId,
    isNoAuth: false,
  };
}

export async function finalizeComposioConnection(input: {
  projectId: string;
  slug: string;
  app: string;
  connectionId: string;
  stableUserId: string;
  sessionId: string;
  authRequestId?: string;
  expectedConnectedAccountId?: string;
  runtime?: ComposioRuntime;
}): Promise<ComposioFinalizeResult> {
  assertStableUserId(input.connectionId, input.stableUserId);
  const session = await (input.runtime ?? getComposioRuntime()).sessions.use(input.sessionId);
  const state = await loadToolkitState(session, input.app);
  if (state.isNoAuth) {
    return {
      connected: true,
      sessionId: session.sessionId,
      ...(input.authRequestId ? { authRequestId: input.authRequestId } : {}),
      isNoAuth: true,
    };
  }

  const connectedAccountId = activeConnectedAccountId(state);
  if (
    connectedAccountId &&
    input.expectedConnectedAccountId &&
    connectedAccountId !== input.expectedConnectedAccountId
  ) {
    throw new Error('composio_connected_account_mismatch');
  }
  return {
    connected: !!connectedAccountId,
    ...(connectedAccountId ? { connectedAccountId } : {}),
    sessionId: session.sessionId,
    ...(input.authRequestId ? { authRequestId: input.authRequestId } : {}),
    isNoAuth: false,
  };
}
