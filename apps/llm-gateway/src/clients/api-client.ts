import { TimeoutError, withRetry } from '@kortix/llm-gateway';
import {
  GatewayResolutionError,
  type NoUpstreamReasonCode,
  type AuthedPrincipal,
  type AuthorizeResult,
  type GatewayTrace,
  type ListModelsOptions,
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
  listModels: (principal: AuthedPrincipal, opts?: ListModelsOptions) => Promise<ModelCatalog>;
  ping: () => Promise<ApiPingResult>;
}

/** Calls the caller is waiting on — see `post`'s `retryOnTimeout`. */
const RETRY_SLOW = { retryOnTimeout: true } as const;

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 5_000;

  /**
   * One control-plane call, with bounded retries.
   *
   * `retryOnTimeout` says whether a SLOW attempt (one that produced no response
   * inside `timeoutMs`) may be repeated. It is a per-call decision because the
   * two kinds of call differ in what a repeat costs:
   *
   * - Admission and resolution calls are what the caller is waiting on. A
   *   repeat that succeeds turns a hard error into a served request. The
   *   admission hold is the one nuance: `/authorize` may already have taken a
   *   1-cent atomic hold the timed-out attempt never learned about, and that
   *   hold is orphaned — but it is orphaned by the timeout itself, not by the
   *   retry, and NOT retrying leaves the same orphan plus a failed request. Only
   *   a full control-plane outage (every attempt times out) can orphan more than
   *   one, and nothing is being served then anyway.
   * - `recordUsage` / `recordTrace` are settlement WRITES with nobody waiting.
   *   A timed-out attempt that the API actually committed would be charged
   *   twice by a repeat, so they keep the narrow policy: retry a refused or
   *   5xx-answered attempt, never a silent one.
   */
  const post = async <T>(
    path: string,
    payload: unknown,
    { retryOnTimeout = false }: { retryOnTimeout?: boolean } = {},
  ): Promise<T> => {
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
        // `timeoutMs` is a PER-ATTEMPT budget, and withRetry settles an attempt
        // that overruns it with a `TimeoutError` — not with whatever `fn` would
        // eventually have thrown once the abort landed. Accepting only
        // `ApiUnavailableError` here therefore made `maxAttempts: 3` dead code
        // for the single failure mode these retries exist for: a SLOW control
        // plane. The un-retried `TimeoutError` escaped `authorize()` in
        // simple-handler.ts and reached the client as an opaque
        // `503 gateway_error "Gateway unavailable"`.
        //
        // Measured on staging 2026-09-16: 2 of 30 identical
        // `POST /v1/llm/chat/completions` calls answered that 503 at 5.14 s and
        // 5.15 s (exactly this 5 s budget); the other 28 answered
        // `400 provider_disabled` in 2.0-3.2 s. That is the GW-ACCESS-1
        // release-gate flake (runs 35012251397, 35036053187).
        //
        // Worst case stays bounded by `maxAttempts`: 3 x 5 s plus ~0.3 s of
        // backoff before the caller is told the API is unreachable.
        isRetryable: (err) =>
          err instanceof ApiUnavailableError || (retryOnTimeout && err instanceof TimeoutError),
      },
    );
  };

  return {
    authenticate: async (token) => {
      const result = await post<{ principal: AuthedPrincipal | null }>(
        '/internal/gateway/authenticate',
        { token },
        RETRY_SLOW,
      );
      return result.principal ?? null;
    },
    authorize: async (token) => {
      return post<AuthorizeResult>('/internal/gateway/authorize', { token }, RETRY_SLOW);
    },
    resolveRoute: async (principal, input) => {
      const result = await post<{ route: ModelRoutePlan | null }>(
        '/internal/gateway/resolve-route',
        { principal, input },
        RETRY_SLOW,
      );
      return result.route ?? null;
    },
    resolveUpstream: async (principal, model) => {
      const result = await post<{
        candidates?: UpstreamDescriptor[];
        resolutionError?: {
          code: NoUpstreamReasonCode;
          message: string;
          suggestion: string;
        };
      }>('/internal/gateway/resolve-upstream', { principal, model }, RETRY_SLOW);
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
        RETRY_SLOW,
      );
      if (!result.active) {
        throw new Error(result.message ?? 'subscription required');
      }
      return result.holdUsd ? { holdUsd: result.holdUsd } : undefined;
    },
    assertBudget: async (principal) => {
      const result = await post<{ exceeded: boolean; message?: string; warnings?: string[] }>(
        '/internal/gateway/budget-check',
        { principal },
        RETRY_SLOW,
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
    listModels: async (principal, opts) => {
      const result = await post<{ models: ModelCatalog }>(
        '/internal/gateway/models',
        {
          principal,
          managedOnly: !!opts?.managedOnly,
          ...(opts?.scope ? { scope: opts.scope } : {}),
        },
        RETRY_SLOW,
      );
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
