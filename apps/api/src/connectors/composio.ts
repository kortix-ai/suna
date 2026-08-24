import {
  Composio,
  type ToolRouterCreateSessionConfig,
  type ToolRouterSessionExecuteResponse,
  type ToolkitConnectionsDetails,
} from '@composio/core';
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
  authConfigs?: {
    list(query: {
      toolkit?: string;
      search?: string;
      isComposioManaged?: boolean;
      limit?: number;
    }): Promise<{ items: Array<{ id: string; name: string }> }>;
    create(
      toolkit: string,
      options: {
        type: 'use_composio_managed_auth';
        name: string;
        credentials: { scopes: string };
        isEnabledForToolRouter: boolean;
      },
    ): Promise<{ id: string }>;
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

const MANAGED_AUTH_CONFIGS: Record<string, { name: string; scopes: readonly string[] }> = {
  gmail: {
    name: 'Kortix Gmail managed actions v1',
    // Composio's default Gmail auth config did not grant fetch_emails enough
    // access in a real connection. Keep the permissions explicit instead of
    // using the broader https://mail.google.com/ scope.
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.labels',
    ],
  },
};

const authConfigCache = new WeakMap<ComposioRuntime, Map<string, Promise<string>>>();

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

function directSessionConfig(
  toolkit: string,
  connectedAccountId?: string | null,
  authConfigId?: string,
): ToolRouterCreateSessionConfig {
  return {
    sessionPreset: 'direct_tools',
    toolkits: [toolkit],
    manageConnections: false,
    sandbox: { enable: false },
    ...(authConfigId ? { authConfigs: { [toolkit]: authConfigId } } : {}),
    ...(connectedAccountId ? { connectedAccounts: { [toolkit]: connectedAccountId } } : {}),
  };
}

async function managedAuthConfigId(
  runtime: ComposioRuntime,
  toolkit: string,
): Promise<string | undefined> {
  const spec = MANAGED_AUTH_CONFIGS[toolkit.toLowerCase()];
  if (!spec) return undefined;
  if (!runtime.authConfigs) {
    throw new Error('Composio auth config API is unavailable');
  }

  let cache = authConfigCache.get(runtime);
  if (!cache) {
    cache = new Map();
    authConfigCache.set(runtime, cache);
  }
  const existing = cache.get(toolkit);
  if (existing) return existing;

  const resolved = (async () => {
    const page = await runtime.authConfigs!.list({
      toolkit,
      search: spec.name,
      isComposioManaged: true,
      limit: 100,
    });
    const match = page.items.find((item) => item.name === spec.name);
    if (match) return match.id;

    const created = await runtime.authConfigs!.create(toolkit, {
      type: 'use_composio_managed_auth',
      name: spec.name,
      credentials: { scopes: spec.scopes.join(',') },
      isEnabledForToolRouter: true,
    });
    return created.id;
  })();
  cache.set(toolkit, resolved);
  try {
    return await resolved;
  } catch (error) {
    cache.delete(toolkit);
    throw error;
  }
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

export async function composioCatalogPage(input: {
  projectId: string;
  q?: string;
  category?: string;
  cursor?: string;
  limit?: number;
  runtime?: ComposioRuntime;
}): Promise<
  | ToolkitConnectionsDetails
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
  return session.toolkits({
    ...(input.q?.trim() ? { search: input.q.trim() } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit != null ? { limit: input.limit } : {}),
  });
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
  const authConfigId = await managedAuthConfigId(runtime, input.app);
  const session = await runtime.sessions.create(
    input.stableUserId,
    directSessionConfig(input.app, null, authConfigId),
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

  const request = await session.authorize(input.app, {
    ...(input.redirects?.success ? { callbackUrl: input.redirects.success } : {}),
    alias: input.slug,
  });
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
