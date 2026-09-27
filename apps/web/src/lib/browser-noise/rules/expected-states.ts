import type { NoiseRule } from '../evidence';
import { normalizeString } from '../evidence';

// Transient "the session runtime / sandbox URL hasn't pinned yet" throws. The
// SDK throws `RuntimeNotReadyError` (`[opencode-sdk] Server URL not ready —
// sandbox is still loading`) from `getClient()` for the ~1s window before a
// new/switched session's runtime URL resolves; sibling guards reuse the same
// wording for the pty/env paths (`[kortix-pty] Server URL not ready …`). It is
// an EXPECTED, self-healing info state — never an error — but it can reach
// Sentry through paths that don't go through the global `app/error.tsx`
// boundary's manual guard: a subtree wrapped in `<ClientErrorBoundary>`
// (whose `componentDidCatch` captures unconditionally), `route-error`/
// `system-fault`, `error-handler`'s network branch, and unhandled promise
// rejections auto-captured by the Sentry SDK. Filter it once, here, so every
// capture path drops it. The render-path UI handling lives in `app/error.tsx`
// + `SandboxLoadingBoundary`; this is the telemetry-side backstop.
const RUNTIME_NOT_READY_NOISE_PATTERNS = [
  'Server URL not ready',
  'sandbox is still loading',
  'opencode not ready',
] as const;

// Expected billing-gate HTTP 402 messages. The API billing gate
// (`apps/api/src/billing/services/billing-gate.ts:assertBillingActive`) throws
// a 402 carrying one of these exact strings in the response body
// (`{ error: <message>, code, balance, account_id }`); the SDK surfaces them as
// an `ApiError` (message === the body's `error` field). They are EXPECTED,
// user-facing business states — `apps/web/src/lib/error-handler.tsx:handleApiError`
// already routes a structured 402 to a top-up toast / upgrade dialog and
// intentionally only reports 5xx/network/timeout to Sentry. But the `ApiError`
// can leak through capture paths that bypass that guard
// (`route-error`/`system-fault`/`app/error`/`<ClientErrorBoundary>` and the
// Sentry SDK's own `onunhandledrejection`), so the exact billing-gate strings
// are dropped here at the telemetry gate regardless of which path delivered
// them. Real `ApiError`s ("Internal server error", "HTTP 500: …", …) keep
// reporting — only exact matches for these messages (plus the explicit
// canonical wrappers below) are suppressed.
const BILLING_GATE_EXPECTED_MESSAGES = [
  // `insufficient_credits` — wallet ran dry on an active plan.
  'Out of credits. Top up to continue.',
  // `no_account` — no credit account found.
  'No credit account found. Complete account setup first.',
  // `subscription_required` — per-seat account with no active subscription.
  // Must match apps/api/src/billing/services/billing-gate.ts VERBATIM. The seat
  // price moved to $40 there and this copy was left at $20, so the filter
  // stopped matching and an expected billing state has been paging as an error.
  'Subscribe to activate your seat. $40/teammate per month includes wallet credits for compute and LLM usage.',
] as const;

// Expected "no compaction model configured" configuration state. The SDK's
// `useSummarizeRuntimeSession` mutation
// (`packages/sdk/src/react/use-opencode-sessions/sessions.ts`) throws a
// sentinel-marked `NoCompactionModelError`
// (`packages/sdk/src/react/use-opencode-sessions/no-compaction-model-error.ts`,
// mirrored locally by `apps/mobile/lib/opencode/hooks/use-compact-session.ts`)
// when every model-resolution fallback tier fails (no config default, no
// assistant message in the thread, no connected provider/model). It is an
// EXPECTED, user-facing configuration outcome — the host already surfaces it
// via the `loadingToast` error toast ("No model available for compaction.
// Please configure a model in settings.") and the global react-query mutation
// `onError` toast — never a code defect.
//
// It leaks to Sentry as an unhandled promise rejection: `compact-modal.tsx`
// fires `void loadingToast(() => summarize.mutateAsync(...))`, and
// `loadingToast` re-throws the error after showing the toast (toast.tsx), so
// the `void`-fired rejection is auto-captured by the Sentry SDK's
// `onunhandledrejection` integration. Drop it here at the telemetry gate so
// the expected config state never pages Better Stack, regardless of which
// capture path delivered it. A longer real mutation failure (network error,
// `summarize` 5xx, a genuine `TypeError`, …) keeps reporting — only an exact
// match for this message (plus the explicit canonical wrappers below) is
// suppressed.
const COMPACTION_NO_MODEL_EXPECTED_MESSAGES = [
  'No model available for compaction. Please configure a model in settings.',
] as const;

// Expected "model not available for this account" UI validation state. The API
// returns a TYPED 409 with `code: 'model_not_servable'`
// (`apps/api/src/projects/routes/models.ts` and `channel-bindings.ts:288`, both
// via `isModelServableForAccount`) when a user picks a model their account
// can't use — a free-tier managed model, or a BYOK model whose provider isn't
// connected. The SAME wording is also returned as a 400 with
// `code: 'INVALID_SESSION_MODEL'` (`apps/api/src/projects/routes/r7.ts:2811`
// and `apps/api/src/projects/lib/sessions.ts:741`) for an explicit session
// model. Both are EXPECTED, user-facing validation states — the SDK's
// `useModelDefaults` `setMutation` `onError` already branches on the typed
// 409 code and surfaces a user-facing toast via `platformConfig().onToast`,
// and `makeRequest` already classifies the typed 409 as SILENT to `onError`
// (Sentry) — see `MODEL_NOT_SERVABLE_CODE` in
// `packages/sdk/src/core/http/api-client.ts` (PR #6082).
//
// BUT every call site fire-and-forgets the returned promise —
// `void setAccountDefault(...)` / `void setAgentDefault(...)` /
// `void setProjectDefault(...)` in `session-chat.tsx:3416/3422/3426`,
// `agents-view.tsx:297`, `gateway-view.tsx:137`, and `models-tab.tsx:156`.
// The chain: `setModelDefault` → `unwrap(backendApi.put(...))` THROWS the
// `ApiError` on `!res.success` → `mutateAsync` rejects → the `async` wrapper's
// (`setAccountDefault`/…) promise rejects → `void` discards the rejected
// promise with no `.catch()` → UNHANDLED rejection → Sentry's
// `onunhandledrejection` global handler auto-captures it. The `setMutation`
// `onError` SWALLOWS the rejection inside react-query (the toast fires), but
// react-query v5's `onError` does NOT prevent `mutateAsync`'s returned
// promise from rejecting, so the `void`-discarded promise still surfaces as
// an uncaught global rejection. The SDK `makeRequest` gate silences the
// `onError` (Sentry) callback, but the unhandled rejection happens at the
// `.then()`/`void` level — AFTER `makeRequest` returned — so the gate never
// sees it. This left the 7 occurrences STILL reaching Sentry as UNCAUGHT
// `onunhandledrejection` (`handled:false`) post-#6082.
//
// Better Stack pattern
// 9784f440a71c4430667ed3aca8b727c065f38c226ecad3f33f37c7a86476a576
// (Kortix Frontend prod, application_id 2346967): `ApiError`, message
// `Model "openai/gpt-5.4-mini" is not available for this account`, 7
// occurrences / 0 identified users, first 2026-08-06 05:09 UTC (ALL
// post-v0.12.4, release `160f0b286f0ad5c53debc343d5e055241694e24d`),
// request URL `https://kortix.com/projects/<project_id>/sessions/<session_id>`
// (co-worker session page), browser Android Chrome mobile, mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT,
// `handled:false`).
//
// This is the leak-path backstop for the #6082 SDK gate, sibling to
// `isExpectedBillingGateMessage` / `isExpectedCompactionNoModelMessage`
// (also `ApiError`/Error throws that leak via `void` fire-and-forget →
// `onunhandledrejection`). The model name varies (e.g.
// `openai/gpt-5.4-mini`, `nvidia/minimaxai/minimax-m3`), so — unlike the
// billing-gate / compaction exact-string matchers — this is a REGEX anchored
// on the EXACT API wording `Model "…" is not available for this account`
// (the `Model "` prefix and `is not available for this account` suffix are
// the API's own canonical strings across all four emitting routes), with the
// canonical `ApiError: ` / `Unhandled promise rejection: ` wrappers stripped
// so all capture paths (window.onerror, onunhandledrejection, Sentry
// exception) classify consistently. Deliberately message-only with NO
// first-party frame negative guard — mirroring the billing-gate / compaction
// matchers — because (a) the message is the API's own canonical wording
// (never a coincidental app-logic phrase), (b) the SDK gate already handles
// the `onError` path, and (c) the unhandled-rejection stack DOES carry
// resolved first-party `apps/web/src/…` call-site frames (the `void`
// call sites in `session-chat.tsx`/`agents-view.tsx`/`gateway-view.tsx`), so a
// first-party negative guard would FAIL to suppress the actual prod noise.
// A genuine first-party `throw new Error('Model "…" is not available for this
// account')` regression is vanishingly unlikely (the wording is the API's,
// not app logic) AND is already covered by the SDK's `onError` Sentry
// capture for non-409 cases. NOT added to `sentry.client.config.ts`'s
// `ignoreErrors` list as a bare regex — that gate has no frame context and
// the message is specific enough that the `beforeSend` hook
// (`shouldIgnoreSentryBrowserNoise`) is the safe gate; the anchored regex
// below covers frameless `onunhandledrejection` captures too.
const MODEL_NOT_SERVABLE_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  // The bare API message (the SDK `ApiError.message`), with any non-empty
  // model id between the quotes.
  /^Model "[^"]+" is not available for this account$/,
  // `ApiError: `-prefixed wrapper (e.g. a console/error-boundary re-throw, or
  // Sentry's exception `value` formatting).
  /^ApiError: Model "[^"]+" is not available for this account$/,
  // An unhandled-rejection wrapper preserving the message (Sentry
  // `onunhandledrejection` auto-capture, `handled:false`).
  /^Unhandled promise rejection: Model "[^"]+" is not available for this account$/,
  // An unhandled-rejection wrapper around an `ApiError:`-prefixed re-throw
  // (the full wrapper stack).
  /^Unhandled promise rejection: ApiError: Model "[^"]+" is not available for this account$/,
];

// The SDK's client-side request deadline. `packages/sdk/src/core/http/api-client.ts`
// aborts a non-streaming fetch once its 30s budget elapses (the `didTimeout`
// branch — distinct from an external abort) and surfaces
// `ApiError("Request timed out after <N>s: <endpoint>", { code: 'TIMEOUT' })`.
//
// This is the frontend mirror of the API's request-deadline 503
// (`apps/api/src/middleware/request-deadline.ts`, de-noised from Sentry by
// https://github.com/kortix-ai/suna/pull/4524). The API bounds every
// non-streaming request to a 25s server deadline that returns a clean 503 +
// `Retry-After: 10`, and react-query retries background polls (the session-audit
// route that produced Better Stack pattern `b1db01e5…` is polled every 5–15s
// from several session surfaces), so a 30s client abort is an EXPECTED,
// retryable degradation under momentary API saturation — never an actionable
// bug. The saturation signal remains visible in the per-route
// `http_request_duration_seconds` metric and the structured
// `Request completed: … 503 …` warn log, exactly as for the server-side 503.
//
// `handleApiError` already drops `code === 'TIMEOUT'` from `captureException`;
// this is the telemetry-side backstop that drops it from any capture path that
// bypasses that guard — `<ClientErrorBoundary>`, `route-error`/`system-fault`,
// `app/error`, and the Sentry SDK's own `onunhandledrejection` — same shape as
// the billing-gate / runtime-not-ready backstops. The match is anchored on the
// SDK's exact `Request timed out after <N>s:` prefix (with the canonical
// wrappers) so a third-party library's generic "request timed out" message, or
// the API's different `Request exceeded the 25s server processing deadline`
// wording, is never matched.
const CLIENT_REQUEST_TIMEOUT_WRAPPERS: ReadonlyArray<RegExp> = [
  /^Request timed out after \d+s: /,
  /^ApiError: Request timed out after \d+s: /,
  /^Unhandled promise rejection: (?:ApiError: )?Request timed out after \d+s: /,
];

// The API's server-side request-deadline 503.
// `apps/api/src/middleware/request-deadline.ts` bounds every non-streaming
// request to a 25s wall-clock deadline (default `REQUEST_DEADLINE_MS`); when a
// handler exceeds it, the `RequestDeadlineHTTPException` returns a clean 503 +
// `Retry-After: 10` with the message
// `Request exceeded the <N>s server processing deadline`. It is an EXPECTED,
// retryable degradation — the deadline net bounding a slow downstream / a
// pool-saturated request — and is already de-noised at the API SOURCE
// (`apps/api/src/index.ts` `onError` skips `captureException` for
// `isRequestDeadlineHTTPException(err)` — PR #4524, API Sentry app 2346961).
//
// BUT the 503 RESPONSE crosses the boundary into the frontend: the SDK's
// `makeRequest` extracts `errorData.message` (the deadline string), wraps it in
// an `ApiError` with `status: 503`, and fires `onError` → `handleApiError`,
// which captures it to the FRONTEND Sentry (app 2346967 — a SEPARATE app from
// the API's). That is exactly how Better Stack FRONTEND pattern
// `a330bea1…` (`ApiError: Request exceeded the 25s server processing deadline`,
// on the `useSessionAudit` background poll, 1 occ / 0 users) reached the
// frontend telemetry despite #4524's API-side classification. The
// `TRANSIENT_GATEWAY_STATUSES` retry (#4609) absorbs a SINGLE transient 503 on
// idempotent reads, but persistent saturation exhausts the 2-retry loop (the
// prod breadcrumbs showed 3 non-200 audit 503s) and surfaces the deadline 503
// to `onError` → Sentry.
//
// This is the frontend mirror of the API's request-deadline classification,
// sibling to `isClientRequestTimeoutMessage` (the SDK's 30s CLIENT abort,
// #4531). The deadline 503 is the SAME expected/retryable degradation class,
// just observed server-side instead of client-side — react-query retries
// background polls, and the saturation signal stays visible in the per-route
// `http_request_duration_seconds` metric + the structured
// `Request completed: … 503 …` warn log on the API. The match is anchored on
// the API's exact `Request exceeded the <N>s server processing deadline`
// wording (with the canonical `ApiError: ` / unhandled-rejection wrappers) so
// a generic 503 (`HTTP 503: Service Unavailable`, `sandbox waking up`) is
// never matched — only the typed deadline message the API's
// `RequestDeadlineHTTPException` emits.
const SERVER_DEADLINE_NOISE_WRAPPERS: ReadonlyArray<RegExp> = [
  /^Request exceeded the \d+s server processing deadline$/,
  /^ApiError: Request exceeded the \d+s server processing deadline$/,
  /^Unhandled promise rejection: (?:ApiError: )?Request exceeded the \d+s server processing deadline$/,
];

const GIT_MIRROR_UNAVAILABLE_NOISE_WRAPPERS: ReadonlyArray<RegExp> = [
  /^git mirror is temporarily unavailable$/,
  /^ApiError: git mirror is temporarily unavailable$/,
  /^Unhandled promise rejection: (?:ApiError: )?git mirror is temporarily unavailable$/,
];

export function isGitMirrorUnavailableNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message).trim();
  return GIT_MIRROR_UNAVAILABLE_NOISE_WRAPPERS.some((re) => re.test(normalized));
}

/**
 * Whether a message is the transient, self-healing "session runtime not ready
 * yet" state — `[opencode-sdk] Server URL not ready — sandbox is still loading`
 * and its sibling variants. Such a message must NEVER page Better Stack: it
 * resolves on its own within ~1s (every session switch/provisioning window).
 */
export function isRuntimeNotReadyNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message).toLowerCase();
  return RUNTIME_NOT_READY_NOISE_PATTERNS.some((pattern) =>
    normalized.includes(pattern.toLowerCase()),
  );
}

/**
 * Whether a message is an EXPECTED billing-gate HTTP 402 outcome (insufficient
 * credits / no account / subscription required). These are user-facing business
 * states already handled by a top-up toast or upgrade dialog in
 * `error-handler.tsx`; they must NEVER page Better Stack, but the SDK's
 * `ApiError` can leak to Sentry through capture paths that bypass
 * `handleApiError`'s 402 guard. Match is exact after trimming, with only the
 * canonical browser/Sentry wrappers we explicitly support, so a longer real
 * `ApiError` that merely contains the billing phrase is never matched.
 */
export function isExpectedBillingGateMessage(message: unknown): boolean {
  const normalized = normalizeString(message).trim();
  return BILLING_GATE_EXPECTED_MESSAGES.some(
    (expected) =>
      normalized === expected ||
      normalized === `ApiError: ${expected}` ||
      normalized === `Unhandled promise rejection: ${expected}` ||
      normalized === `Unhandled promise rejection: ApiError: ${expected}`,
  );
}

/**
 * Whether a message is the EXPECTED "no compaction model configured"
 * configuration state thrown by the SDK's `useSummarizeRuntimeSession`
 * mutation (`NoCompactionModelError`) when every model-resolution fallback
 * tier fails. The host already surfaces it via a user-facing toast; it must
 * never page Better Stack, but the sentinel error can leak to Sentry as an
 * unhandled promise rejection (`void loadingToast(...)` re-throws after
 * showing the toast → `onunhandledrejection` auto-capture). Match is exact
 * after trimming, with only the canonical browser/Sentry wrappers we
 * explicitly support, so a longer real error that merely mentions the wording
 * is never matched.
 */
export function isExpectedCompactionNoModelMessage(message: unknown): boolean {
  const normalized = normalizeString(message).trim();
  return COMPACTION_NO_MODEL_EXPECTED_MESSAGES.some(
    (expected) =>
      normalized === expected ||
      normalized === `Error: ${expected}` ||
      normalized === `Unhandled promise rejection: ${expected}` ||
      normalized === `Unhandled promise rejection: Error: ${expected}`,
  );
}

/**
 * Whether a message is the EXPECTED "model not available for this account"
 * UI validation state — the typed 409 `code: 'model_not_servable'` the API
 * returns (`apps/api/src/projects/routes/models.ts` + `channel-bindings.ts` via
 * `isModelServableForAccount`, plus the 400 `INVALID_SESSION_MODEL` sibling in
 * `r7.ts` + `sessions.ts`) when a user picks a model their account can't use.
 * The SDK's `useModelDefaults` `setMutation` `onError` already surfaces a
 * user-facing toast, and `makeRequest` already classifies the typed 409 as
 * SILENT to `onError` (Sentry) — see `MODEL_NOT_SERVABLE_CODE` (PR #6082) —
 * but every call site fire-and-forgets the returned promise
 * (`void setAccountDefault(...)` / `void setAgentDefault(...)` /
 * `void setProjectDefault(...)`), so the rejected `mutateAsync` becomes an
 * UNHANDLED rejection → Sentry's `onunhandledrejection` (`handled:false`),
 * which the #6082 SDK gate never sees (it's past the `makeRequest` return).
 * This is the leak-path backstop. The model name varies, so the match is a
 * REGEX anchored on the EXACT API wording `Model "…" is not available for
 * this account`, with the canonical `ApiError: ` / `Unhandled promise
 * rejection: ` wrappers, so a longer real error that merely mentions the
 * phrase is never matched. Sibling to `isExpectedBillingGateMessage` /
 * `isExpectedCompactionNoModelMessage` (also `ApiError`/Error throws that
 * leak via `void` fire-and-forget); deliberately message-only with NO
 * first-party frame negative guard — see `MODEL_NOT_SERVABLE_NOISE_PATTERNS`
 * for the full rationale. See Better Stack pattern `9784f440…`.
 */
export function isModelNotServableNoise(message: unknown): boolean {
  const normalized = normalizeString(message).trim();
  return MODEL_NOT_SERVABLE_NOISE_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Whether a message is the SDK's client-side request-deadline timeout —
 * `Request timed out after <N>s: <endpoint>` (and its canonical wrappers). This
 * is an EXPECTED, retryable degradation (the API's 25s server deadline returns
 * a 503 + Retry-After and react-query retries background polls), never an
 * actionable bug — see `CLIENT_REQUEST_TIMEOUT_WRAPPERS` for the full
 * rationale. Such a message must NEVER page Better Stack, regardless of which
 * capture path delivered it.
 */
export function isClientRequestTimeoutMessage(message: unknown): boolean {
  const normalized = normalizeString(message).trim();
  return CLIENT_REQUEST_TIMEOUT_WRAPPERS.some((re) => re.test(normalized));
}

/**
 * Whether a message is the API's server-side request-deadline 503 —
 * `Request exceeded the <N>s server processing deadline` (and its canonical
 * wrappers). This is the SERVER-side mirror of `isClientRequestTimeoutMessage`
 * (the SDK's 30s CLIENT abort): the API bounds non-streaming requests to a 25s
 * deadline that returns a clean 503 + `Retry-After`, de-noised at the API
 * source by #4524. But the 503 response crosses into the frontend as an
 * `ApiError(status: 503)` (the SDK extracts `.message`), which `handleApiError`
 * captures to the FRONTEND Sentry — Better Stack pattern `a330bea1…`. It is
 * an EXPECTED, retryable degradation (react-query retries background polls; the
 * saturation signal stays in per-route metrics + the structured 503 warn log),
 * never an actionable bug. Such a message must NEVER page Better Stack,
 * regardless of which capture path delivered it.
 */
export function isServerDeadlineNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message).trim();
  return SERVER_DEADLINE_NOISE_WRAPPERS.some((re) => re.test(normalized));
}

// Expected app and API states: the SDK and API emit these exact messages for
// conditions the UI already handles (toast, dialog, retry). They leak to
// telemetry through capture paths that bypass `handleApiError`
// (`<ClientErrorBoundary>`, route / system-fault boundaries, `app/error`, and
// fire-and-forget promises that reach `onunhandledrejection`). Each matcher
// above is the telemetry-side backstop for one state; see its constant for the
// full rationale.
export const EXPECTED_STATE_RULES: readonly NoiseRule[] = [
  {
    id: 'runtime-not-ready',
    appliesTo: 'both',
    match: ({ message }) => isRuntimeNotReadyNoiseMessage(message),
  },
  {
    id: 'client-request-timeout',
    appliesTo: 'both',
    match: ({ message }) => isClientRequestTimeoutMessage(message),
  },
  {
    id: 'server-deadline',
    appliesTo: 'both',
    match: ({ message }) => isServerDeadlineNoiseMessage(message),
  },
  {
    id: 'git-mirror-unavailable',
    appliesTo: 'both',
    match: ({ message }) => isGitMirrorUnavailableNoiseMessage(message),
  },
  {
    id: 'billing-gate',
    appliesTo: 'both',
    match: ({ message }) => isExpectedBillingGateMessage(message),
  },
  {
    id: 'compaction-no-model',
    appliesTo: 'both',
    match: ({ message }) => isExpectedCompactionNoModelMessage(message),
  },
  {
    id: 'model-not-servable',
    appliesTo: 'both',
    match: ({ message }) => isModelNotServableNoise(message),
  },
];
