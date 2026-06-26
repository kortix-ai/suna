import { withRetry } from '@kortix/llm-gateway';
import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayTrace,
  ModelCatalog,
  UpstreamDescriptor,
  UsageEvent,
} from '@kortix/llm-gateway';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class ApiUnavailableError extends Error {
  constructor(
    readonly path: string,
    readonly status?: number,
  ) {
    super(`kortix api ${path} unavailable${status ? ` (${status})` : ''}`);
    this.name = 'ApiUnavailableError';
  }
}

export interface ApiPingResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

export interface ApiClient {
  authenticate: (token: string) => Promise<AuthedPrincipal | null>;
  authorize: (token: string) => Promise<AuthorizeResult>;
  resolveUpstream: (principal: AuthedPrincipal, model: string) => Promise<UpstreamDescriptor[]>;
  assertBillingActive: (accountId: string) => Promise<void>;
  assertBudget: (principal: AuthedPrincipal) => Promise<void>;
  recordUsage: (event: UsageEvent) => Promise<void>;
  recordTrace: (trace: GatewayTrace) => Promise<void>;
  listModels: (principal: AuthedPrincipal) => Promise<ModelCatalog>;
  ping: () => Promise<ApiPingResult>;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const post = async <T>(path: string, payload: unknown): Promise<T> => {
    return withRetry(
      async (signal) => {
        let response: Response;
        try {
          response = await fetchImpl(`${baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${opts.token}`,
            },
            body: JSON.stringify(payload),
            signal,
          });
        } catch {
          throw new ApiUnavailableError(path);
        }
        if (!response.ok) {
          throw new ApiUnavailableError(path, response.status);
        }
        return (await response.json()) as T;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        timeoutMs,
        isRetryable: (err) => err instanceof ApiUnavailableError,
      },
    );
  };

  return {
    authenticate: async (token) => {
      const result = await post<{ principal: AuthedPrincipal | null }>(
        '/internal/gateway/authenticate',
        { token },
      );
      return result.principal ?? null;
    },
    authorize: async (token) => {
      return post<AuthorizeResult>('/internal/gateway/authorize', { token });
    },
    resolveUpstream: async (principal, model) => {
      const result = await post<{ candidates: UpstreamDescriptor[] }>(
        '/internal/gateway/resolve-upstream',
        {
          principal,
          model,
        },
      );
      return result.candidates ?? [];
    },
    assertBillingActive: async (accountId) => {
      const result = await post<{ active: boolean; message?: string }>(
        '/internal/gateway/billing',
        { accountId },
      );
      if (!result.active) {
        throw new Error(result.message ?? 'subscription required');
      }
    },
    assertBudget: async (principal) => {
      const result = await post<{ exceeded: boolean; message?: string }>(
        '/internal/gateway/budget-check',
        {
          principal,
        },
      );
      if (result.exceeded) {
        throw new Error(result.message ?? 'Budget exceeded');
      }
    },

    recordUsage: async (event) => {
      await post<{ ok: boolean }>('/internal/gateway/usage', { event });
    },
    recordTrace: async (trace) => {
      await post<{ ok: boolean }>('/internal/gateway/trace', { trace });
    },
    listModels: async (principal) => {
      const result = await post<{ models: ModelCatalog }>('/internal/gateway/models', {
        principal,
      });
      return result.models ?? {};
    },
    ping: async () => {
      const started = Date.now();
      try {
        const res = await fetchImpl(`${baseUrl}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(3_000),
        });
        return { ok: res.ok, latencyMs: Date.now() - started, status: res.status };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
