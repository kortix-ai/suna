import { z } from 'zod';
import {
  NangoError,
  githubReconnectRequired,
  invalidNangoResponse,
  nangoRateLimited,
  nangoUnavailable,
} from './errors';

const DEFAULT_BASE_URL = 'https://api.nango.dev';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;

const tagsSchema = z.record(z.string(), z.string());
const unknownRecordSchema = z.record(z.string(), z.unknown());

const connectSessionResponseSchema = z
  .object({
    data: z
      .object({
        token: z.string().min(1),
        expires_at: z.string().min(1),
        connect_link: z.string().url(),
      })
      .passthrough(),
  })
  .passthrough();

const connectionSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    connection_id: z.string().min(1),
    provider_config_key: z.string().min(1),
    provider: z.string().min(1),
    errors: z
      .array(
        z
          .object({
            type: z.string(),
            log_id: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    metadata: unknownRecordSchema.nullable().optional(),
    connection_config: unknownRecordSchema.optional(),
    tags: tagsSchema.optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    last_fetched_at: z.string().nullable().optional(),
    credentials: z.unknown().optional(),
  })
  .passthrough();

const connectionListResponseSchema = z.union([
  z
    .object({
      connections: z.array(connectionSchema),
    })
    .passthrough()
    .transform((value) => value.connections),
  z
    .object({
      data: z.array(connectionSchema),
    })
    .passthrough()
    .transform((value) => value.data),
]);

const deleteConnectionResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .passthrough();

export type NangoTags = Record<string, string>;

export interface NangoConnectSession {
  token: string;
  expiresAt: string;
  connectLink: string;
}

export interface NangoConnectionSummary {
  id?: string | number;
  connectionId: string;
  integrationId: string;
  provider: string;
  errors: Array<{ type: string; logId?: string }>;
  metadata: Record<string, unknown>;
  connectionConfig: Record<string, unknown>;
  tags: NangoTags;
  createdAt?: string;
  updatedAt?: string;
  lastFetchedAt?: string | null;
}

export interface NangoConnection extends NangoConnectionSummary {
  credentials: unknown;
}

export interface NangoClient {
  createConnectSession(input: NangoConnectSessionInput): Promise<NangoConnectSession>;
  createReconnectSession(input: NangoReconnectSessionInput): Promise<NangoConnectSession>;
  listConnections(input?: NangoListConnectionsInput): Promise<NangoConnectionSummary[]>;
  getConnection(input: NangoGetConnectionInput): Promise<NangoConnection>;
  deleteConnection(input: NangoConnectionRef): Promise<void>;
}

export interface NangoConnectSessionInput {
  integrationId: string;
  tags: NangoTags;
  webhookUrlOverride?: string;
}

export interface NangoReconnectSessionInput extends NangoConnectSessionInput {
  connectionId: string;
}

export interface NangoListConnectionsInput {
  connectionId?: string;
  integrationId?: string;
  tags?: NangoTags;
  limit?: number;
  page?: number;
}

export interface NangoConnectionRef {
  connectionId: string;
  integrationId: string;
}

export interface NangoGetConnectionInput extends NangoConnectionRef {
  forceRefresh?: boolean;
  refreshGithubAppJwtToken?: boolean;
}

export interface NangoClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

function toConnection(value: z.output<typeof connectionSchema>): NangoConnectionSummary {
  return {
    ...(value.id !== undefined ? { id: value.id } : {}),
    connectionId: value.connection_id,
    integrationId: value.provider_config_key,
    provider: value.provider,
    errors: value.errors.map((error) => ({
      type: error.type,
      ...(error.log_id ? { logId: error.log_id } : {}),
    })),
    metadata: value.metadata ?? {},
    connectionConfig: value.connection_config ?? {},
    tags: value.tags ?? {},
    ...(value.created_at ? { createdAt: value.created_at } : {}),
    ...(value.updated_at ? { updatedAt: value.updated_at } : {}),
    ...(value.last_fetched_at !== undefined ? { lastFetchedAt: value.last_fetched_at } : {}),
  };
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw invalidNangoResponse();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string): unknown {
  if (!text) throw invalidNangoResponse();
  try {
    return JSON.parse(text);
  } catch {
    throw invalidNangoResponse();
  }
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new TypeError('Nango base URL must use HTTPS.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function createNangoClient(options: NangoClientOptions): NangoClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new TypeError('Nango API key is required.');

  const baseUrl = normalizedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<Schema extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: Schema,
    body?: unknown,
    reconnectOnMissingConnection = false,
  ): Promise<z.output<Schema>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: 'error',
      });

      if (response.status === 429) {
        throw nangoRateLimited(response.headers.get('retry-after') ?? undefined);
      }
      if (!response.ok) {
        if (reconnectOnMissingConnection && (response.status === 404 || response.status === 424)) {
          throw githubReconnectRequired(response.status);
        }
        if (response.status >= 500) throw nangoUnavailable(response.status);
        throw invalidNangoResponse(response.status);
      }

      const payload = parseJson(await readBoundedText(response));
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw invalidNangoResponse();
      return parsed.data as z.output<Schema>;
    } catch (error) {
      if (error instanceof NangoError) throw error;
      throw nangoUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  async function createSession(
    path: '/connect/sessions' | '/connect/sessions/reconnect',
    body: Record<string, unknown>,
  ): Promise<NangoConnectSession> {
    const response = await request('POST', path, connectSessionResponseSchema, body);
    return {
      token: response.data.token,
      expiresAt: response.data.expires_at,
      connectLink: response.data.connect_link,
    };
  }

  return {
    createConnectSession: async (input) =>
      createSession('/connect/sessions', {
        allowed_integrations: [input.integrationId],
        tags: input.tags,
        ...(input.webhookUrlOverride ? { webhook_url_override: input.webhookUrlOverride } : {}),
      }),

    createReconnectSession: async (input) =>
      createSession('/connect/sessions/reconnect', {
        connection_id: input.connectionId,
        integration_id: input.integrationId,
        tags: input.tags,
        ...(input.webhookUrlOverride ? { webhook_url_override: input.webhookUrlOverride } : {}),
      }),

    listConnections: async (input = {}) => {
      const search = new URLSearchParams();
      if (input.connectionId) search.set('connectionId', input.connectionId);
      if (input.integrationId) search.set('integrationId', input.integrationId);
      for (const [key, value] of Object.entries(input.tags ?? {})) {
        search.set(`tags[${key}]`, value);
      }
      if (input.limit !== undefined) search.set('limit', String(input.limit));
      if (input.page !== undefined) search.set('page', String(input.page));
      const suffix = search.size ? `?${search.toString()}` : '';
      const connections = await request(
        'GET',
        `/connections${suffix}`,
        connectionListResponseSchema,
      );
      return connections.map(toConnection);
    },

    getConnection: async (input) => {
      const search = new URLSearchParams({
        provider_config_key: input.integrationId,
      });
      if (input.forceRefresh) search.set('force_refresh', 'true');
      if (input.refreshGithubAppJwtToken) {
        search.set('refresh_github_app_jwt_token', 'true');
      }
      const encodedConnectionId = encodeURIComponent(input.connectionId);
      const response = await request(
        'GET',
        `/connections/${encodedConnectionId}?${search.toString()}`,
        connectionSchema,
        undefined,
        true,
      );
      if (response.credentials === undefined) throw invalidNangoResponse();
      return {
        ...toConnection(response),
        credentials: response.credentials,
      };
    },

    deleteConnection: async (input) => {
      const search = new URLSearchParams({
        provider_config_key: input.integrationId,
      });
      const encodedConnectionId = encodeURIComponent(input.connectionId);
      await request(
        'DELETE',
        `/connections/${encodedConnectionId}?${search.toString()}`,
        deleteConnectionResponseSchema,
      );
    },
  };
}
