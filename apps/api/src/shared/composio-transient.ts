/**
 * Composio (hosted connectors provider) transient-failure classification.
 *
 * Every Composio API call goes through `@composio/client`'s `makeRequest`,
 * which retries transient failures itself (maxRetries 2 — three attempts,
 * 0.5 s → 1 s exponential backoff capped at 8 s) and then throws a typed
 * subclass of `APIError` (`core/error.mjs`, Stainless-generated):
 *   - `InternalServerError` — EVERY HTTP 5xx from Composio's API, carrying the
 *     parsed body as `.error` and the upstream message in `.message`
 *     (`500 {"error":{…}}`). Prod fingerprint (Better Stack pattern
 *     `0386d70c…`, 2026-10-15): `Failed to fetch API key information from DB`
 *     (Composio error code 809) on
 *     `GET /v1/connectors/projects/:projectId/connect/toolkits?limit=12` — a
 *     102 s request after all three attempts had failed.
 *   - `APIConnectionError` / `APIConnectionTimeoutError` — network-level
 *     failure or the client's own timeout.
 *
 * Such a failure is EXPECTED — the provider is momentarily unavailable, not a
 * Kortix code bug — and every call site that hits Composio (toolkits
 * catalogue, connect flows, tool execution, sync) must NOT page Sentry for
 * it. `app.onError` calls `isComposioTransientProviderError` and downgrades
 * the failure to a retryable 503 + `Retry-After` WITHOUT paging Sentry,
 * mirroring the `PlatinumSandboxNotRunningError`, `GitOperationError:timeout`,
 * Daytona-transient and request-deadline patterns.
 *
 * Deliberately NOT classified (must stay loud, falling through to the generic
 * capture):
 *   - Composio 4xx — `BadRequestError` (400), `AuthenticationError` (401),
 *     `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError`
 *     (409), `UnprocessableEntityError` (422): a real request fault or
 *     credential problem, not a transient provider state;
 *   - `RateLimitError` (429): `executeComposio` already answers it at its
 *     call site as a real HTTP 429 + `Retry-After`
 *     (apps/api/src/connectors/composio.ts); an unguarded 429 that bubbles
 *     into `app.onError` should page until it gets the same call-site
 *     treatment — the same ownership rule the Daytona classifiers follow
 *     (`isDaytonaRateLimitError` owns the 429 there);
 *   - `APIUserAbortError` (a caller aborted the request) — not a provider
 *     failure at all.
 *
 * The classifier is deliberately conservative: it matches ONLY the SDK's own
 * error classes, never a bare `Error` that merely carries a 5xx-shaped field
 * (an unrelated upstream must keep paging).
 *
 * The classes are imported lazily and primed at bootstrap
 * (`primeComposioTransientClassifier` from `src/index.ts`) so a broken SDK
 * install never breaks the classifier (it is on the global error path — it
 * must always load), and so the Composio client is not force-loaded at boot
 * for deployments without `COMPOSIO_API_KEY` (`loadComposioAdapter` loads it
 * lazily). `instanceof` is sound rather than best-effort here: an error of
 * these classes can only exist after `@composio/client` has been imported
 * somewhere in the process, and apps/api pins the exact same version
 * `@composio/core` depends on, so there is exactly one class identity. Before
 * the prime resolves (only reachable in the first milliseconds of boot, before
 * any Composio call can have run) the classifier answers `false` and the
 * behavior is identical to pre-classifier.
 */

type ComposioErrorCtor = abstract new (...args: unknown[]) => Error;
type LoadedComposioClasses = {
  InternalServerError: ComposioErrorCtor | null;
  APIConnectionError: ComposioErrorCtor | null;
};
let loadedClasses: LoadedComposioClasses | undefined;

async function loadComposioErrorClasses(): Promise<LoadedComposioClasses> {
  if (loadedClasses !== undefined) return loadedClasses;
  try {
    const mod = (await import('@composio/client')) as {
      InternalServerError?: ComposioErrorCtor;
      APIConnectionError?: ComposioErrorCtor;
    };
    loadedClasses = {
      InternalServerError: mod.InternalServerError ?? null,
      // `APIConnectionTimeoutError` extends `APIConnectionError`, so one
      // instanceof check covers both connection shapes.
      APIConnectionError: mod.APIConnectionError ?? null,
    };
  } catch {
    loadedClasses = { InternalServerError: null, APIConnectionError: null };
  }
  return loadedClasses;
}

/**
 * True when `err` is a transient Composio provider failure: the SDK's
 * `InternalServerError` (any HTTP 5xx from Composio's API) or
 * `APIConnectionError` (network failure / client timeout; includes its
 * subclass `APIConnectionTimeoutError`). See the module doc above for what is
 * deliberately NOT matched.
 *
 * Pure / synchronous so `app.onError` can call it on the hot path without
 * awaiting an import.
 */
export function isComposioTransientProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cls = loadedClasses;
  if (!cls) return false;
  if (cls.InternalServerError && err instanceof cls.InternalServerError) return true;
  if (cls.APIConnectionError && err instanceof cls.APIConnectionError) return true;
  return false;
}

/**
 * Pre-load the Composio client's error classes so the synchronous
 * `isComposioTransientProviderError` instanceof path is available. Called once
 * during app bootstrap. Safe to call multiple times; never throws.
 */
export async function primeComposioTransientClassifier(): Promise<void> {
  await loadComposioErrorClasses();
}

/**
 * Stable error code the platform API returns (HTTP 503) for a transient
 * Composio provider failure, so the SDK/frontend can classify the response as
 * an EXPECTED, retryable degradation (silent to the frontend Sentry) instead
 * of an opaque `ApiError`. Must stay in sync with the local
 * `CONNECTORS_PROVIDER_UNAVAILABLE_CODE` in
 * `packages/sdk/src/core/http/response-error.ts` (the git-mirror precedent:
 * the API-side classification alone only de-noises the API's OWN Sentry; the
 * 503 response crosses into the FRONTEND Sentry, a separate app, via
 * `handleApiError`).
 */
export const CONNECTORS_PROVIDER_UNAVAILABLE_CODE = 'connectors_provider_unavailable';
