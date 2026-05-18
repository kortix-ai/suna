import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, desc, eq } from 'drizzle-orm';
import {
  projectConnectionTools,
  projectConnections,
  projectSessions,
} from '@kortix/db';
import {
  mcpTextResult,
  toMcpToolDescriptor,
  verifyExecutorMcpSessionToken,
  type ExecutorMcpSessionTokenContext,
} from '@kortix/executor-bridge';
import type { AppContext } from '../../types';
import { config } from '../../config';
import { db } from '../../shared/db';
import { getProjectSecretValue } from '../../projects/secrets';

export const sessionMcp = new Hono<{ Variables: AppContext }>();

let pipedreamAccessToken: string | null = null;
let pipedreamTokenExpiresAt = 0;
type ProjectConnectionRow = typeof projectConnections.$inferSelect;
type ProjectConnectionToolRow = typeof projectConnectionTools.$inferSelect;
type EnabledToolEntry = {
  connection: ProjectConnectionRow;
  tool: ProjectConnectionToolRow;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function bearerToken(c: any): string | null {
  const header = c.req.header('Authorization') || c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

async function resolveMcpContext(c: any): Promise<ExecutorMcpSessionTokenContext> {
  const verified = verifyExecutorMcpSessionToken(bearerToken(c), config.API_KEY_SECRET);
  if (!verified.ok) {
    throw new HTTPException(401, { message: `Invalid Executor MCP token: ${verified.reason}` });
  }

  const [session] = await db
    .select({
      sessionId: projectSessions.sessionId,
    })
    .from(projectSessions)
    .where(and(
      eq(projectSessions.sessionId, verified.context.sessionId),
      eq(projectSessions.projectId, verified.context.projectId),
      eq(projectSessions.accountId, verified.context.accountId),
    ))
    .limit(1);

  if (!session) {
    throw new HTTPException(403, { message: 'Executor MCP token is not valid for an active project session' });
  }

  return verified.context;
}

function rpcResult(id: JsonRpcRequest['id'], result: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function getPipedreamConfig() {
  const clientId = process.env.PIPEDREAM_CLIENT_ID;
  const clientSecret = process.env.PIPEDREAM_CLIENT_SECRET;
  const projectId = process.env.PIPEDREAM_PROJECT_ID;
  const environment = process.env.PIPEDREAM_ENVIRONMENT || 'production';
  if (!clientId || !clientSecret || !projectId) {
    throw new Error('Pipedream is not configured');
  }
  return { clientId, clientSecret, projectId, environment };
}

async function getPipedreamApiToken(): Promise<string> {
  if (pipedreamAccessToken && Date.now() < pipedreamTokenExpiresAt - 60_000) {
    return pipedreamAccessToken;
  }

  const cfg = getPipedreamConfig();
  const res = await fetch('https://api.pipedream.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Pipedream auth failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string; expires_in?: number };
  pipedreamAccessToken = data.access_token;
  pipedreamTokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return pipedreamAccessToken;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') headers[key] = raw;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readCredentialMap(configValue: unknown): Record<string, unknown> {
  return isRecord(configValue) ? configValue : {};
}

async function resolveCredentialBinding(
  projectId: string,
  config: Record<string, unknown>,
  configuredValue: unknown,
): Promise<string | null> {
  if (typeof configuredValue === 'string') return configuredValue;
  if (!isRecord(configuredValue) || configuredValue.kind !== 'binding') return null;
  const slot = readString(configuredValue.slot);
  if (!slot) return null;

  const bindings = Array.isArray(config.credential_bindings)
    ? config.credential_bindings
    : [];
  const binding = bindings.find((entry) =>
    isRecord(entry)
    && readString(entry.slot) === slot
    && readString(entry.secret_name));
  if (!isRecord(binding)) return null;

  const secretName = readString(binding.secret_name);
  if (!secretName) return null;
  const secret = await getProjectSecretValue(projectId, secretName);
  if (secret === null) return null;
  const prefix = readString(configuredValue.prefix) ?? '';
  return `${prefix}${secret}`;
}

async function resolveCredentialRecord(
  projectId: string,
  config: Record<string, unknown>,
  configKey: 'headers' | 'queryParams',
) {
  const entries = readCredentialMap(config[configKey]);
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(entries)) {
    const credential = await resolveCredentialBinding(projectId, config, value);
    if (credential !== null) resolved[name] = credential;
  }
  return resolved;
}

async function resolveAuthHeaders(
  projectId: string,
  config: Record<string, unknown>,
): Promise<Record<string, string>> {
  const auth = isRecord(config.auth) ? config.auth : {};
  const type = readString(auth.type);
  if (!type) return {};

  if (type === 'basic') {
    const username = readString(auth.username);
    const password = await resolveCredentialBinding(projectId, config, auth.password);
    if (!username || password === null) return {};
    return {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    };
  }

  if (type === 'oauth2_client_credentials') {
    const tokenUrl = readString(auth.token_url);
    const clientId = await resolveCredentialBinding(projectId, config, auth.client_id);
    const clientSecret = await resolveCredentialBinding(projectId, config, auth.client_secret);
    if (!tokenUrl || clientId === null || clientSecret === null) return {};

    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const scopes = readString(auth.scopes);
    if (scopes) form.set('scope', scopes);

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new Error(`OAuth token request failed (${res.status}): ${await res.text()}`);
    }
    const token = await res.json() as { access_token?: string; token_type?: string };
    if (!token.access_token) throw new Error('OAuth token response did not include access_token');
    return {
      Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`,
    };
  }

  return {};
}

function allowedHttpMethod(value: unknown) {
  const raw = typeof value === 'string' ? value.toUpperCase() : 'GET';
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(raw) ? raw : 'GET';
}

function applyQueryParams(url: URL, params: Record<string, unknown>) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function resolveHttpTargetUrl(config: Record<string, unknown>, input: Record<string, unknown>) {
  const absolute = readString(input.url);
  if (absolute) return new URL(absolute);

  const base = readString(config.base_url) ?? readString(config.baseUrl) ?? readString(config.endpoint) ?? readString(config.url);
  const path = readString(input.path) ?? '';
  if (!base) throw new Error('Source is missing base_url; pass an absolute url argument');
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return new URL(path.replace(/^\/+/, '') || '.', normalizedBase);
}

async function resolveConfiguredRequestParts(
  projectId: string,
  config: Record<string, unknown>,
) {
  const [headers, queryParams, authHeaders] = await Promise.all([
    resolveCredentialRecord(projectId, config, 'headers'),
    resolveCredentialRecord(projectId, config, 'queryParams'),
    resolveAuthHeaders(projectId, config),
  ]);

  return {
    headers: {
      ...headers,
      ...authHeaders,
    },
    queryParams,
  };
}

async function fetchAsStructuredResponse(url: URL, init: RequestInit) {
  const res = await fetch(url, init);
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();
  return {
    status: res.status,
    headers: responseHeaders,
    body,
  };
}

async function proxyConfiguredHttpRequest(
  projectId: string,
  connection: ProjectConnectionRow,
  args: Record<string, unknown>,
) {
  const config = isRecord(connection.config) ? connection.config : {};
  const url = resolveHttpTargetUrl(config, args);
  const resolved = await resolveConfiguredRequestParts(projectId, config);
  applyQueryParams(url, resolved.queryParams);
  if (isRecord(args.query)) applyQueryParams(url, args.query);

  const method = allowedHttpMethod(args.method);
  const headers: Record<string, string> = {
    ...normalizeHeaders(args.headers),
    ...resolved.headers,
  };
  const hasBody = args.body !== undefined && args.body !== null && method !== 'GET';
  if (hasBody && !Object.keys(headers).some((header) => header.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  return fetchAsStructuredResponse(url, {
    method,
    headers,
    ...(hasBody ? { body: JSON.stringify(args.body) } : {}),
  });
}

async function proxyConfiguredGraphqlRequest(
  projectId: string,
  connection: ProjectConnectionRow,
  args: Record<string, unknown>,
) {
  const config = isRecord(connection.config) ? connection.config : {};
  const endpoint = readString(config.endpoint) ?? readString(config.url);
  if (!endpoint) throw new Error('GraphQL source is missing endpoint');

  const query = readString(args.query);
  if (!query) throw new Error('GraphQL tool requires a query argument');

  const url = new URL(endpoint);
  const resolved = await resolveConfiguredRequestParts(projectId, config);
  applyQueryParams(url, resolved.queryParams);

  const headers: Record<string, string> = {
    ...normalizeHeaders(args.headers),
    ...resolved.headers,
    'Content-Type': 'application/json',
  };
  const body = {
    query,
    ...(isRecord(args.variables) ? { variables: args.variables } : {}),
    ...(readString(args.operationName) ? { operationName: readString(args.operationName) } : {}),
  };

  return fetchAsStructuredResponse(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function proxyRemoteMcpRequest(
  projectId: string,
  connection: ProjectConnectionRow,
  args: Record<string, unknown>,
) {
  const config = isRecord(connection.config) ? connection.config : {};
  const endpoint = readString(config.url) ?? readString(config.endpoint);
  if (!endpoint) throw new Error('MCP source is missing server URL');

  const method = readString(args.method);
  if (!method) throw new Error('MCP proxy requires a JSON-RPC method argument');

  const url = new URL(endpoint);
  const resolved = await resolveConfiguredRequestParts(projectId, config);
  applyQueryParams(url, resolved.queryParams);

  const headers: Record<string, string> = {
    ...normalizeHeaders(args.headers),
    ...resolved.headers,
    'Content-Type': 'application/json',
  };
  const rpcBody = {
    jsonrpc: '2.0',
    id: typeof args.id === 'string' || typeof args.id === 'number' ? args.id : 'kortix',
    method,
    params: isRecord(args.params) ? args.params : {},
  };

  return fetchAsStructuredResponse(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcBody),
  });
}

async function proxyPipedreamRequest(input: {
  accountId: string;
  app: string;
  providerAccountId?: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}) {
  const cfg = getPipedreamConfig();
  const token = await getPipedreamApiToken();
  const encodedUrl = base64UrlEncode(input.url);
  const params = new URLSearchParams({
    external_user_id: input.accountId,
  });
  if (input.providerAccountId) params.set('account_id', input.providerAccountId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-pd-environment': cfg.environment,
  };

  for (const [key, value] of Object.entries(input.headers)) {
    const lower = key.toLowerCase();
    if (lower !== 'authorization' && lower !== 'host') {
      headers[`x-pd-proxy-${key}`] = value;
    }
  }

  const hasBody = input.body !== undefined && input.body !== null;
  if (hasBody) headers['Content-Type'] = 'application/json';

  const res = await fetch(
    `https://api.pipedream.com/v1/connect/${cfg.projectId}/proxy/${encodedUrl}?${params.toString()}`,
    {
      method: input.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
    },
  );

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();

  return {
    status: res.status,
    headers: responseHeaders,
    body,
  };
}

async function listEnabledTools(ctx: ExecutorMcpSessionTokenContext) {
  const connections = await db
    .select()
    .from(projectConnections)
    .where(and(
      eq(projectConnections.projectId, ctx.projectId),
      eq(projectConnections.accountId, ctx.accountId),
      eq(projectConnections.enabled, true),
    ))
    .orderBy(desc(projectConnections.updatedAt));

  if (connections.length === 0) return [];

  const connectionsById = new Map(connections.map((connection) => [connection.connectionId, connection]));
  const enabledConnectionIds = new Set(connectionsById.keys());
  const tools = await db
    .select()
    .from(projectConnectionTools)
    .where(and(
      eq(projectConnectionTools.projectId, ctx.projectId),
      eq(projectConnectionTools.accountId, ctx.accountId),
      eq(projectConnectionTools.enabled, true),
    ))
    .orderBy(desc(projectConnectionTools.updatedAt));

  return tools
    .filter((tool) => enabledConnectionIds.has(tool.connectionId))
    .map((tool) => ({
      tool,
      connection: connectionsById.get(tool.connectionId)!,
    }));
}

async function invokeExecutorTool(
  ctx: ExecutorMcpSessionTokenContext,
  entry: EnabledToolEntry,
  args: unknown,
) {
  const { connection, tool } = entry;
  const implementation = tool.implementation ?? {};
  const kind = typeof implementation.kind === 'string' ? implementation.kind : 'echo';

  if (kind === 'static_text' || kind === 'text') {
    return mcpTextResult(String(implementation.text ?? ''));
  }

  if (kind === 'echo') {
    const structuredContent = {
      tool: tool.name,
      arguments: args && typeof args === 'object' ? args : {},
    };
    return mcpTextResult(JSON.stringify(structuredContent), structuredContent);
  }

  if (kind === 'pipedream_proxy') {
    const app = typeof implementation.app === 'string' ? implementation.app : '';
    const providerAccountId = typeof implementation.provider_account_id === 'string'
      ? implementation.provider_account_id
      : undefined;
    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!app) {
      return mcpTextResult('Pipedream tool is missing app configuration');
    }
    if (!/^https?:\/\//.test(url)) {
      return mcpTextResult('Pipedream tool requires an absolute http(s) url argument');
    }

    const rawMethod = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(rawMethod) ? rawMethod : 'GET';
    const response = await proxyPipedreamRequest({
      accountId: ctx.accountId,
      app,
      providerAccountId,
      url,
      method,
      headers: normalizeHeaders(input.headers),
      body: input.body,
    });
    return mcpTextResult(JSON.stringify(response), response);
  }

  if (kind === 'http_proxy') {
    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    const response = await proxyConfiguredHttpRequest(ctx.projectId, connection, input);
    return mcpTextResult(JSON.stringify(response), response);
  }

  if (kind === 'graphql_proxy') {
    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    const response = await proxyConfiguredGraphqlRequest(ctx.projectId, connection, input);
    return mcpTextResult(JSON.stringify(response), response);
  }

  if (kind === 'mcp_remote_proxy') {
    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    const response = await proxyRemoteMcpRequest(ctx.projectId, connection, input);
    return mcpTextResult(JSON.stringify(response), response);
  }

  return mcpTextResult(`Unsupported Executor bridge tool kind: ${kind}`);
}

sessionMcp.post('/', async (c) => {
  const ctx = await resolveMcpContext(c);

  let body: JsonRpcRequest;
  try {
    const parsed = await c.req.json();
    if (Array.isArray(parsed)) {
      return c.json(rpcError(null, -32600, 'Batch JSON-RPC is not supported yet'), 400);
    }
    body = parsed as JsonRpcRequest;
  } catch {
    return c.json(rpcError(null, -32700, 'Invalid JSON body'), 400);
  }

  if (!body.method) {
    return c.json(rpcError(body.id, -32600, 'JSON-RPC method is required'), 400);
  }

  if (body.id === undefined && body.method.startsWith('notifications/')) {
    return c.body(null, 204);
  }

  if (body.method === 'initialize') {
    return c.json(rpcResult(body.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'kortix-executor-bridge', version: '0.1.0' },
      instructions: 'Kortix Executor bridge exposes project-approved tools for this session.',
    }));
  }

  if (body.method === 'tools/list') {
    const tools = await listEnabledTools(ctx);
    return c.json(rpcResult(body.id, {
      tools: tools.map((entry) => toMcpToolDescriptor({
        name: entry.tool.name,
        description: entry.tool.description,
        inputSchema: entry.tool.inputSchema,
      })),
    }));
  }

  if (body.method === 'tools/call') {
    const params = body.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    if (!name) {
      return c.json(rpcError(body.id, -32602, 'tools/call requires params.name'), 400);
    }

    const tools = await listEnabledTools(ctx);
    const entry = tools.find((item) => item.tool.name === name);
    if (!entry) {
      return c.json(rpcError(body.id, -32004, `Tool not found or not enabled: ${name}`), 404);
    }

    try {
      return c.json(rpcResult(body.id, await invokeExecutorTool(ctx, entry, params.arguments ?? {})));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Executor tool call failed';
      return c.json(rpcError(body.id, -32000, message), 502);
    }
  }

  return c.json(rpcError(body.id, -32601, `Unsupported MCP method: ${body.method}`), 404);
});
