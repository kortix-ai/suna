import { withRetry } from '@kortix/llm-gateway';
import {
  GatewayResolutionError,
  type AuthedPrincipal,
  type AuthorizeResult,
  type GatewayTrace,
  type ModelCatalog,
  type ModelRouteInput,
  type ModelRoutePlan,
  type UpstreamDescriptor,
  type UsageEvent,
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
  resolveRoute: (
    principal: AuthedPrincipal,
    input: ModelRouteInput,
  ) => Promise<ModelRoutePlan | null>;
  resolveUpstream: (principal: AuthedPrincipal, model: string) => Promise<UpstreamDescriptor[]>;
  assertBillingActive: (accountId: string) => Promise<{ holdUsd?: number } | void>;
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
    resolveRoute: async (principal, input) => {
      const result = await post<{ route: ModelRoutePlan | null }>(
        '/internal/gateway/resolve-route',
        { principal, input },
      );
      return result.route ?? null;
    },
    resolveUpstream: async (principal, model) => {
      const result = await post<{
        candidates?: UpstreamDescriptor[];
        resolutionError?: {
          code: 'model_not_found' | 'model_disabled_on_deployment' | 'plan_upgrade_required' | 'provider_not_connected' | 'provider_reauth_required';
          message: string;
          suggestion: string;
        };
      }>('/internal/gateway/resolve-upstream', {
        principal,
        model,
      });
      // The API catches GatewayResolutionError in /resolve-upstream and returns
      // it in a 200 body instead of letting it propagate as a 500 (which would
      // be captured to Sentry AND retried 3x here). Re-throw it as the typed
      // error so the pipeline's dispatch loop (handler.ts) sees the same
      // contract as the in-process hook (hooks.ts: resolveUpstream:
      // resolveCandidates) — a thrown GatewayResolutionError it can surface as
      // a clean 400 with the actionable suggestion, rather than a generic
      // ApiUnavailableError 5xx.
      if (result.resolutionError) {
        const { code, message, suggestion } = result.resolutionError;
        throw new GatewayResolutionError(code, message, suggestion);
      }
      return result.candidates ?? [];
    },
    assertBillingActive: async (accountId) => {
      const result = await post<{ active: boolean; message?: string; holdUsd?: number }>(
        '/internal/gateway/billing',
        { accountId },
      );
      if (!result.active) {
        throw new Error(result.message ?? 'subscription required');
      }
      return result.holdUsd ? { holdUsd: result.holdUsd } : undefined;
    },
    assertBudget: async (principal) => {
      const result = await post<{ exceeded: boolean; message?: string; warnings?: string[] }>(
        '/internal/gateway/budget-check',
        {
          principal,
        },
      );
      // A 'warn' budget must never block — but it must not be a silent no-op
      // either (see checkBudget in the API's budgets.ts). This granular
      // fallback path isn't on the standalone gateway's hot path (it always
      // sets the combined `authorize` hook instead), but keep it honest too.
      for (const message of result.warnings ?? []) {
        console.warn(`[gateway] budget warn threshold reached: ${message}`, {
          accountId: principal.accountId,
          projectId: principal.projectId,
        });
      }
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
