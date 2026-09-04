import {
  Composio,
  type ToolRouterCreateSessionConfig,
  type ToolRouterSessionExecuteResponse,
  type ToolkitConnectionsDetails,
} from '@composio/core';
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

export function setComposioRuntimeForTest(next: ComposioRuntime | null): void {
  runtime = next;
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

/**
 * Description + categories for every toolkit, keyed by slug.
 *
 * The paged browse endpoint (`session.toolkits()`) returns only
 * `{slug, name, logo, isNoAuth, connection}` — no description and no
 * categories. The catalogue page grouped those items into sections by category,
 * so every toolkit fell into the client's synthetic "Other" bucket, and opening
 * it asked this route for `category=Other`, which is not a Composio category and
 * answered zero. The page then said "Catalogue unavailable" over a catalogue
 * that had just rendered.
 *
 * `toolkits.get()` carries both fields, so the page is enriched from it rather
 * than served by it: that endpoint caps at 1000 toolkits while the catalogue is
 * ~1400, and it publishes no cursor, so it cannot page.
 *
 * Cached per runtime because it is one 800ms request for data that changes when
 * Composio adds an app, not per user. A failure resolves to an empty map and
 * leaves the page unenriched — a card with no description beats no card.
 */
interface ToolkitMeta {
  description: string | null;
  categories: string[];
}

/**
 * The paged browse response, plus the two fields the provider's paged endpoint
 * omits. Declared rather than inferred so a caller that groups by `categories`
 * cannot compile against a page that never carries them.
 */
export type EnrichedToolkitConnectionsPage = Omit<ToolkitConnectionsDetails, 'items'> & {
  items: Array<ToolkitConnectionsDetails['items'][number] & ToolkitMeta>;
};

const TOOLKIT_META_TTL_MS = 6 * 60 * 60_000;

const toolkitMetaCache = new WeakMap<
  ComposioRuntime,
  { at: number; bySlug: Promise<Map<string, ToolkitMeta>> }
>();

async function toolkitMetaBySlug(runtime: ComposioRuntime): Promise<Map<string, ToolkitMeta>> {
  const cached = toolkitMetaCache.get(runtime);
  if (cached && Date.now() - cached.at < TOOLKIT_META_TTL_MS) return cached.bySlug;
  if (!runtime.toolkits) return new Map();

  const bySlug = (async () => {
    const page = await runtime.toolkits!.get({ limit: 1000 });
    const map = new Map<string, ToolkitMeta>();
    for (const toolkit of page) {
      map.set(toolkit.slug.toLowerCase(), {
        description: toolkit.meta?.description ?? null,
        categories: (toolkit.meta?.categories ?? []).map((category) => category.slug),
      });
    }
    return map;
  })();
  toolkitMetaCache.set(runtime, { at: Date.now(), bySlug });
  try {
    return await bySlug;
  } catch (err) {
    // Drop the poisoned entry so the next request retries instead of serving the
    // rejection for the whole TTL.
    toolkitMetaCache.delete(runtime);
    console.warn('[composio] toolkit metadata unavailable, serving catalogue unenriched:', err);
    return new Map();
  }
}

export async function composioCatalogPage(input: {
  projectId: string;
  q?: string;
  category?: string;
  cursor?: string;
  limit?: number;
  runtime?: ComposioRuntime;
}): Promise<
  | EnrichedToolkitConnectionsPage
  | {
      provider: 'composio';
      toolkits: Array<{
        slug: string;
        name: string;
        logo: string | null;
        description: string | null;
        categories: string[];
        isNoAuth: boolean;
        connected: boolean;
      }>;
      total: number;
      hasMore: false;
    }
> {
  const runtime = input.runtime ?? getComposioRuntime();
  const category = input.category?.trim();
  if (category) {
    if (!runtime.toolkits) throw new Error('Composio toolkit catalogue is unavailable');
    const page = await runtime.toolkits.get({
      category,
      // The core SDK intentionally drops the provider cursor from this endpoint.
      // Fetch the complete category so "View all" never becomes a first-page slice.
      limit: 1000,
    });
    const search = input.q?.trim().toLowerCase();
    const toolkits = search
      ? page.filter((toolkit) =>
          `${toolkit.name} ${toolkit.slug} ${toolkit.meta.description ?? ''}`
            .toLowerCase()
            .includes(search),
        )
      : page;
    return {
      provider: 'composio',
      toolkits: toolkits.map((toolkit) => ({
        slug: toolkit.slug,
        name: toolkit.name,
        logo: toolkit.meta.logo ?? null,
        description: toolkit.meta.description ?? null,
        categories: (toolkit.meta.categories ?? []).map((item) => item.slug),
        isNoAuth: toolkit.noAuth === true,
        connected: false,
      })),
      total: toolkits.length,
      hasMore: false,
    };
  }
  const session = await runtime.sessions.create(`kortix-discovery:${input.projectId}`, {
    manageConnections: false,
    sandbox: { enable: false },
  });
  const [page, meta] = await Promise.all([
    session.toolkits({
      ...(input.q?.trim() ? { search: input.q.trim() } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit != null ? { limit: input.limit } : {}),
    }),
    toolkitMetaBySlug(runtime),
  ]);
  // Enriched in place so the paged shape (`items` + `cursor`) is unchanged and
  // the SDK's existing normalization still applies. A toolkit past the 1000-item
  // metadata cap keeps the empty values it already had.
  return {
    ...page,
    items: page.items.map((item) => {
      const enrichment = meta.get(item.slug.toLowerCase());
      return {
        ...item,
        description: enrichment?.description ?? null,
        categories: enrichment?.categories ?? [],
      };
    }),
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
