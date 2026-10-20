import { TimeoutError, withRetry } from '@kortix/llm-gateway';
import {
  GatewayResolutionError,
  type AdmitResult,
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
  /**
   * The API inside the VPC (KORTIX_API_INTERNAL_URL), tried before `baseUrl`.
   * A call it does not answer marks it down for a minute; `baseUrl` serves.
   */
  internalBaseUrl?: string;
  token: string;
  /** Proof for `/internal/*` at the public API edge (KORTIX_INTERNAL_EDGE_KEY). */
  edgeKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** One /admit attempt: it runs four steps, so it gets more than `timeoutMs`. */
  admitTimeoutMs?: number;
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
  admit: (token: string, input: ModelRouteInput) => Promise<AdmitResult | null>;
  resolveRoute: (
    principal: AuthedPrincipal,
    input: ModelRouteInput,
  ) => Promise<ModelRoutePlan | null>;
  resolveUpstream: (principal: AuthedPrincipal, model: string) => Promise<UpstreamDescriptor[]>;
  notePoolRateLimit: (principal: AuthedPrincipal, secretId: string, seconds: number) => Promise<void>;
  refreshCredential: (principal: AuthedPrincipal, descriptor: UpstreamDescriptor) => Promise<UpstreamDescriptor | null>;
  assertBillingActive: (accountId: string) => Promise<{ holdUsd?: number } | void>;
  assertBudget: (principal: AuthedPrincipal) => Promise<void>;
  recordUsage: (event: UsageEvent) => Promise<void>;
  recordTrace: (trace: GatewayTrace) => Promise<void>;
  listModels: (principal: AuthedPrincipal, opts?: ListModelsOptions) => Promise<ModelCatalog>;
  ping: () => Promise<ApiPingResult>;
}

/** Calls the caller is waiting on — see `post`'s `retryOnTimeout`. */
const RETRY_SLOW = { retryOnTimeout: true } as const;

/** How long an API that answered 404 for `/admit` is not asked again. */
const ADMIT_MISSING_MS = 60_000;

/** How long a private URL that did not answer is skipped for the public one. */
const INTERNAL_DOWN_MS = 60_000;

interface ResolutionErrorBody {
  code: NoUpstreamReasonCode;
  message: string;
  suggestion: string;
  retryAfterSeconds?: number;
}

interface BillingBody {
  active: boolean;
  reason?: string;
  message?: string;
  holdUsd?: number;
}

function resolutionError({ code, message, suggestion, retryAfterSeconds }: ResolutionErrorBody) {
  return new GatewayResolutionError(code, message, suggestion, retryAfterSeconds);
}

/** `/billing`'s answer as `assertBillingActive` returns or throws it. */
function billingResult(result: BillingBody): { holdUsd?: number } | Error {
  if (!result.active) {
    const error = new Error(result.message ?? 'subscription required') as Error & { reason?: string };
    error.reason = result.reason ?? 'subscription_required';
    return error;
  }
  return result.holdUsd ? { holdUsd: result.holdUsd } : {};
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const internalBaseUrl = opts.internalBaseUrl?.replace(/\/+$/, '') || undefined;
  const rawFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  // ponytail: one per-process switch; a broken private path costs one failed attempt per minute.
  let internalDownUntil = 0;
  // A thrown fetch (refused, reset, DNS, timeout) on the private URL sends the
  // next minute of calls to the public one. A response, even a 5xx, is the
  // API answering, so it keeps the private URL.
  const fetchImpl = async (path: string, init: RequestInit): Promise<Response> => {
    const base = internalBaseUrl && Date.now() >= internalDownUntil ? internalBaseUrl : baseUrl;
    try {
      return await rawFetch(`${base}${path}`, init);
    } catch (err) {
      if (base === baseUrl) throw err;
      internalDownUntil = Date.now() + INTERNAL_DOWN_MS;
      // A GET (the ping) repeats safely, so it does not report the API down.
      if (init.method === 'GET') return rawFetch(`${baseUrl}${path}`, init);
      throw err;
    }
  };
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const admitTimeoutMs = opts.admitTimeoutMs ?? 10_000;

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
   * - `/admit` is never repeated (`once`): see `admit` below.
   */
  const post = async <T>(
    path: string,
    payload: unknown,
    { retryOnTimeout = false, once = false }: { retryOnTimeout?: boolean; once?: boolean } = {},
  ): Promise<T> => {
    return withRetry(
      async (signal) => {
        let response: Response;
        try {
          response = await fetchImpl(path, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${opts.token}`,
              // Edge proof for /internal/* on the public API host (api-router worker).
              ...(opts.edgeKey ? { 'x-kortix-internal-edge-key': opts.edgeKey } : {}),
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
        maxAttempts: once ? 1 : 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        timeoutMs: once ? admitTimeoutMs : timeoutMs,
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
          err instanceof ApiUnavailableError ||
          (retryOnTimeout && err instanceof TimeoutError),
      },
    );
  };

  // ponytail: per-process memo; a mixed fleet mid-rollout can flip it once per minute.
  let admitMissingUntil = 0;

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
      return post<AuthorizeResult>('/internal/gateway/authorize', { token, deferBilling: true }, RETRY_SLOW);
    },
    // The gateway and the API roll out independently: an API without
    // `/admit` answers 404, and the handler then uses the separate calls.
    admit: async (token, input) => {
      if (Date.now() < admitMissingUntil) return null;
      let wire: {
        admission: AuthorizeResult;
        route?: ModelRoutePlan | null;
        candidates?: UpstreamDescriptor[];
        resolutionError?: ResolutionErrorBody;
        billing?: BillingBody;
      };
      // One attempt, never repeated: /admit debits the admission hold as its
      // last step, and a timeout, a reset connection or an edge 502/504 can
      // arrive after that debit. A repeat would debit again and only the last
      // hold would reach the gateway. Any of these answers null, and the
      // handler uses the separate calls; the worst case orphans one hold.
      // An API without /admit answers 404 and is not asked for a minute.
      try {
        wire = await post('/internal/gateway/admit', { token, input }, { once: true });
      } catch (error) {
        if (error instanceof TimeoutError) return null;
        if (error instanceof ApiUnavailableError) {
          if (error.status === 404) admitMissingUntil = Date.now() + ADMIT_MISSING_MS;
          if (error.status === undefined || error.status === 404 || error.status >= 500) return null;
        }
        throw error;
      }
      const result: AdmitResult = { admission: wire.admission };
      if (wire.route !== undefined) result.route = wire.route;
      if (wire.resolutionError) result.upstream = resolutionError(wire.resolutionError);
      else if (wire.candidates) result.upstream = wire.candidates;
      if (wire.billing) result.billing = billingResult(wire.billing);
      return result;
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
        resolutionError?: ResolutionErrorBody;
      }>('/internal/gateway/resolve-upstream', { principal, model }, RETRY_SLOW);
      // The API catches GatewayResolutionError in /resolve-upstream and returns
      // it in a 200 body instead of letting it propagate as a 500 (which would
      // be captured to Sentry AND retried 3x here). Re-throw it as the typed
      // error so the pipeline's dispatch loop (handler.ts) sees the same
      // contract as the in-process hook (hooks.ts: resolveUpstream:
      // resolveCandidates) — a thrown GatewayResolutionError it can surface as
      // a clean 400 with the actionable suggestion, rather than a generic
      // ApiUnavailableError 5xx.
      if (result.resolutionError) throw resolutionError(result.resolutionError);
      return result.candidates ?? [];
    },
    notePoolRateLimit: async (principal, secretId, seconds) => {
      await post<{ ok: boolean }>('/internal/gateway/pool-rate-limit', { principal, secretId, seconds });
    },
    // The token itself never crosses back: the API compares a digest to tell
    // a login another request already refreshed from the one that failed.
    refreshCredential: async (principal, descriptor) => {
      if (!descriptor.credentialRef) return null;
      const failedKeySha256 = new Bun.CryptoHasher('sha256').update(descriptor.apiKey).digest('hex');
      const result = await post<{ descriptor: Partial<UpstreamDescriptor> | null }>('/internal/gateway/refresh-credential', {
        principal, secretId: descriptor.credentialRef, failedKeySha256,
      });
      return result.descriptor ? { ...descriptor, ...result.descriptor } : null;
    },
    assertBillingActive: async (accountId) => {
      const result = billingResult(await post<BillingBody>('/internal/gateway/billing', { accountId }, RETRY_SLOW));
      if (result instanceof Error) throw result;
      return result.holdUsd ? result : undefined;
    },
    assertBudget: async (principal) => {
      // Admission evaluates 'block' budgets only. The API evaluates 'warn'
      // budgets after it writes the request's trace row (persistGatewayTrace).
      const result = await post<{ exceeded: boolean; message?: string }>(
        '/internal/gateway/budget-check',
        { principal },
        RETRY_SLOW,
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
        const res = await fetchImpl('/health', {
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
