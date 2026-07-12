const KNOWN_BROWSER_NOISE_MESSAGES = [
  'Invalid call to runtime.sendMessage(). Tab not found.',
  "document.querySelector('video').webkitPresentationMode",
  'webkitPresentationMode',
  'MetaMask extension not found',
  'Looks like your website URL has changed',
  'CookieYes account',
  // Third-party injected scripts / extensions / scanner bots that monkey-patch
  // native Promise internals (e.g. `promise.then = ...`). The native Promise
  // prototype is read-only, so the assignment throws a TypeError that surfaces
  // via onunhandledrejection — it is never our code. Seen from headless
  // tech-detection crawlers hitting the marketing site.
  "Cannot assign to read only property 'then' of object '#<Promise>'",
  'Cannot assign to read only property',
] as const;

// Storage-disabled in-app WebViews (e.g. the Dola Android `wv` browser, UA
// `… wv … cici;AppName/Dola`) resolve `window.localStorage` / `window.sessionStorage`
// to `null` instead of throwing. Any call site that still reaches for storage
// directly then throws `TypeError: Cannot read properties of null (reading
// 'getItem')` (V8) / `Cannot read property 'getItem' of null` (JSC). The
// managed-storage layer + the analytics route-change path route through
// never-throw accessors now, but residual direct call sites elsewhere can still
// surface this as a breadcrumb/cascade on the marketing site. These are
// browser-environment failures (storage genuinely unavailable in that WebView),
// not app defects — `getItem` / `setItem` / `removeItem` are Web Storage API
// method names, so matching them on a `null` access is safe and specific.
const STORAGE_NULL_ACCESS_NOISE_PATTERNS = [
  "Cannot read properties of null (reading 'getItem')",
  "Cannot read properties of null (reading 'setItem')",
  "Cannot read properties of null (reading 'removeItem')",
  "Cannot read property 'getItem' of null",
  "Cannot read property 'setItem' of null",
  "Cannot read property 'removeItem' of null",
] as const;

const KNOWN_TEST_NOISE_MESSAGES = [
  'E2E FINAL:',
  'E2E test:',
] as const;

const KNOWN_DOM_MUTATION_NOISE_MESSAGES = [
  "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
  "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
] as const;

const KNOWN_HYDRATION_NOISE_MESSAGES = [
  'Minified React error #418',
  "Hydration failed because the server rendered",
] as const;

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
  'Subscribe to activate your seat. $20/teammate per month includes wallet credits for compute and LLM usage.',
] as const;

// Stale Next.js webpack runtime chunk after a deploy. A long-lived tab (or
// cached HTML) holds app chunks from one Vercel deployment (`?dpl=dpl_…`) while
// the webpack runtime chunk is served from a different deployment, so
// `__webpack_require__(moduleId)` (minified to function `c`) looks up a module
// id that isn't registered in this runtime's `__webpack_modules__` map →
// `undefined` → `__webpack_modules__[moduleId].call(...)` throws
// `TypeError: Cannot read properties of undefined (reading 'call')`. It is a
// one-off, self-healing-on-reload browser state (single occurrence, 0
// identified users across the four sibling patterns 83e0c2af…/5d02255f…/
// e77f06d4…/1cb3009d…, all last_seen 2026-07-12 08:44 UTC), not an app defect.
// Suppress ONLY when the throwing frame (Sentry's oldest-first stack ordering
// → last frame) is the Next.js webpack runtime chunk, so a genuine app
// TypeError with the same message text — e.g. calling `.call(...)` on an
// `undefined` value inside app code — still reports normally.
const STALE_WEBPACK_RUNTIME_CALL_MESSAGE =
  "Cannot read properties of undefined (reading 'call')";

function isWebpackRuntimeChunkFilename(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return (
    /^app:\/\/\/_next\/static\/chunks\/webpack-[^/]*\.js/.test(normalized)
    || /^https?:\/\/[^/]+\/_next\/static\/chunks\/webpack-[^/]*\.js/.test(normalized)
  );
}

// Old WebKit (Safari < 16.4, iOS < 16.4) cannot parse lookbehind assertions
// `(?<=…)` / `(?<!…)`. JavaScriptCore reads the `(?<` as a named-capture-group
// opener, sees the following `=` / `!`, and throws
// `SyntaxError: Invalid regular expression: invalid group specifier name` at
// chunk PARSE time — so the entire JS chunk fails to load for that visitor.
// The lookbehind literals live in bundled THIRD-PARTY deps we ship on the
// marketing site (the GFM email-autolink regex in `mdast-util-gfm-autolink-
// literal@2.0.1` and `SPLIT_WITH_NEWLINES = /(?<=\n)/` in `@pierre/diffs`),
// not in first-party source, and the wording is WebKit-specific — V8/Node
// never produce it (they say "Invalid group"). Only very old Safari/iOS
// visitors hit it. Suppress this distinctive message so it stops paging
// Better Stack; a genuine first-party regex regression surfaces with a
// different message on modern browsers (which all support lookbehind).
const OLD_WEBKIT_REGEX_NOISE_PATTERNS = [
  'invalid group specifier name',
] as const;

const EXTENSION_PROTOCOL_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://',
  'extension://',
] as const;

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

const INJECTED_APP_SOURCE_PATTERNS = [
  /^app:\/\/\/scripts\/inpage\.js$/,
  /^app:\/\/\/client_data\/[^/]+\/script\.js$/,
  /^app:\/\/\/embed\/embed\.js$/,
] as const;

function containsKnownPattern(message: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isBareImageLoadNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return normalized === 'Failed to load image' || normalized === 'Error: Failed to load image';
}

function isBrowserBundleSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return normalized.startsWith('app:///_next/static/')
    || /^https?:\/\/[^/]+\/_next\/static\//.test(normalized);
}

function extractMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    return normalizeString((value as { message?: unknown }).message);
  }
  return '';
}

export function isKnownBrowserNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, KNOWN_BROWSER_NOISE_MESSAGES);
}

/**
 * Whether a message is the storage-disabled-WebView crash class: a
 * `null.getItem/setItem/removeItem` `TypeError` from `window.localStorage` /
 * `window.sessionStorage` being `null` in an embedded in-app browser. These are
 * browser-environment failures, not app defects (see
 * `STORAGE_NULL_ACCESS_NOISE_PATTERNS`), so they must never page Better Stack.
 */
export function isStorageDisabledWebViewNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, STORAGE_NULL_ACCESS_NOISE_PATTERNS);
}

export function isExtensionSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return EXTENSION_PROTOCOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isInjectedAppSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return INJECTED_APP_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isKnownTestNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, KNOWN_TEST_NOISE_MESSAGES);
}

export function isLikelyDomMutationNoise(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, KNOWN_DOM_MUTATION_NOISE_MESSAGES)
    || containsKnownPattern(normalized, KNOWN_HYDRATION_NOISE_MESSAGES);
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
    (expected) => normalized === expected
      || normalized === `ApiError: ${expected}`
      || normalized === `Unhandled promise rejection: ${expected}`
      || normalized === `Unhandled promise rejection: ApiError: ${expected}`,
  );
}

/**
 * Whether a Sentry exception is the stale-deploy webpack-runtime
 * `… (reading 'call')` TypeError. Requires BOTH the exact webpack
 * module-loader message AND the throwing frame (the last stack frame, per
 * Sentry's oldest-first ordering) to be the Next.js webpack runtime chunk
 * (`_next/static/chunks/webpack-*.js`). A real app TypeError that calls
 * `.call(...)` on an `undefined` value throws inside an app chunk, not the
 * runtime, so it is never hidden. Returns false when there are no frames
 * (can't confirm the runtime scope — keep reporting).
 */
export function isStaleWebpackRuntimeCallNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  if (normalizeString(input.message) !== STALE_WEBPACK_RUNTIME_CALL_MESSAGE) {
    return false;
  }
  const frames = input.frames ?? [];
  if (frames.length === 0) {
    return false;
  }
  const throwingFrame = frames[frames.length - 1];
  return isWebpackRuntimeChunkFilename(throwingFrame?.filename);
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
 * Whether a message is the old-WebKit (< 16.4) lookbehind parse failure
 * `SyntaxError: Invalid regular expression: invalid group specifier name`.
 * The lookbehind lives in bundled third-party deps
 * (`mdast-util-gfm-autolink-literal`, `@pierre/diffs`), the wording is
 * WebKit-specific (V8/Node say "Invalid group"), and only very old Safari/iOS
 * visitors hit it — never page Better Stack for it.
 */
export function isOldWebkitRegexNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message).toLowerCase();
  return OLD_WEBKIT_REGEX_NOISE_PATTERNS.some((pattern) =>
    normalized.includes(pattern.toLowerCase()),
  );
}

export function shouldIgnoreBrowserRuntimeNoise(input: {
  message?: unknown;
  filename?: unknown;
  error?: unknown;
  reason?: unknown;
}): boolean {
  const message = [input.message, extractMessage(input.error), extractMessage(input.reason)]
    .find((value) => Boolean(value)) ?? '';

  if (isKnownBrowserNoiseMessage(message)) {
    return true;
  }

  // Storage-disabled in-app WebViews (storage accessor resolves to `null`)
  // throw `null.getItem/setItem/removeItem` TypeErrors. Browser-environment
  // noise, never an app defect — drop it.
  if (isStorageDisabledWebViewNoiseMessage(message)) {
    return true;
  }

  // Browser-native <img> / next/image load failures can surface as this exact
  // message through window.onerror. Keep this exact: pptx-react-viewer throws
  // actionable errors such as "Failed to load image for colour change
  // processing", which must still reach error tracking.
  if (isBareImageLoadNoiseMessage(message)) {
    return true;
  }

  if (isKnownTestNoiseMessage(message)) {
    return true;
  }

  if (isRuntimeNotReadyNoiseMessage(message)) {
    return true;
  }

  // Expected client-side request-deadline timeouts (SDK 30s fetch abort) — the
  // frontend mirror of the API's request-deadline 503 (de-noised by #4524). An
  // expected, retryable degradation; never page Better Stack for it.
  if (isClientRequestTimeoutMessage(message)) {
    return true;
  }

  // Expected billing-gate 402 outcomes are user-facing business states handled
  // by a toast/upgrade dialog — never page Better Stack for them, even when the
  // SDK's `ApiError` reaches window.onerror / unhandledrejection before
  // `handleApiError` can gate it.
  if (isExpectedBillingGateMessage(message)) {
    return true;
  }

  // Old-WebKit (< 16.4) lookbehind parse failure from bundled third-party
  // deps — WebKit-specific wording, only old Safari/iOS visitors hit it.
  if (isOldWebkitRegexNoiseMessage(message)) {
    return true;
  }

  if (isInjectedAppSource(input.filename)) {
    return true;
  }

  return isExtensionSource(input.filename) && normalizeString(message).includes('runtime.sendMessage');
}

export function shouldIgnoreSentryBrowserNoise(event: {
  message?: unknown;
  request?: { url?: unknown };
  exception?: {
    values?: Array<{
      value?: unknown;
      stacktrace?: { frames?: Array<{ filename?: unknown }> };
    }>;
  };
}): boolean {
  const primaryException = event.exception?.values?.find(Boolean);
  const message = primaryException?.value ?? event.message;
  const frames = primaryException?.stacktrace?.frames ?? [];
  const requestUrl = normalizeString(event.request?.url);
  const environment = normalizeString((event as { environment?: unknown }).environment);

  if (isKnownBrowserNoiseMessage(message)) {
    return true;
  }

  // Storage-disabled in-app WebViews (storage accessor resolves to `null`)
  // throw `null.getItem/setItem/removeItem` TypeErrors. Browser-environment
  // noise, never an app defect — drop it at the Sentry gate too.
  if (isStorageDisabledWebViewNoiseMessage(message)) {
    return true;
  }

  // This helper is also used by the server and edge Sentry configs. Require a
  // browser bundle frame here so a same-worded server exception is not hidden.
  // The client config additionally has an anchored ignoreErrors regex for
  // frame-less browser events.
  if (isBareImageLoadNoiseMessage(message)
    && frames.some((frame) => isBrowserBundleSource(frame.filename))) {
    return true;
  }

  if (isKnownTestNoiseMessage(message)) {
    return true;
  }

  // Transient "session runtime not ready yet" — expected during every session
  // switch/provisioning window, self-heals in ~1s, never an error. Drop it
  // before it pages Better Stack, no matter which capture path delivered it.
  if (isRuntimeNotReadyNoiseMessage(message)) {
    return true;
  }

  // Expected client-side request-deadline timeouts (SDK 30s fetch abort) — the
  // frontend mirror of the API's request-deadline 503 (de-noised by #4524). An
  // expected, retryable degradation under momentary API saturation; the signal
  // remains in per-route metrics + the structured 503 warn log. Drop it before
  // it pages Better Stack, no matter which capture path delivered it.
  if (isClientRequestTimeoutMessage(message)) {
    return true;
  }

  // Expected billing-gate 402 outcomes (insufficient credits / no account /
  // subscription required) are user-facing business states handled by a toast
  // or upgrade dialog. The SDK's `ApiError` can leak to Sentry through capture
  // paths that bypass `handleApiError`'s 402 guard (route/system-fault
  // boundaries, `<ClientErrorBoundary>`, and the Sentry SDK's own
  // `onunhandledrejection`); drop them here so an expected billing state never
  // pages Better Stack. Real `ApiError`s are never matched — only the exact
  // strings the billing gate emits are.
  if (isExpectedBillingGateMessage(message)) {
    return true;
  }

  // Old-WebKit (< 16.4) lookbehind parse failure from bundled third-party
  // deps on the marketing site — WebKit-specific wording, only old Safari/iOS
  // visitors hit it. The de-minified frame points at our own chunk, so this
  // is matched by message, not by source.
  if (isOldWebkitRegexNoiseMessage(message)) {
    return true;
  }

  if (environment === 'test' || environment.startsWith('e2e')) {
    return true;
  }

  // Stale webpack runtime chunk after a deploy — the throwing frame (last
  // stack frame) is the Next.js webpack runtime (`__webpack_require__`,
  // minified `c`) looking up a module id that isn't registered in a
  // mismatched deployment's module map. One-off, self-heals on reload;
  // suppress only when the throwing frame is the runtime chunk so a real app
  // `.call` TypeError keeps reporting. See `isStaleWebpackRuntimeCallNoise`.
  if (isStaleWebpackRuntimeCallNoise({ message, frames })) {
    return true;
  }

  if (frames.some((frame) => isInjectedAppSource(frame.filename))) {
    return true;
  }

  if (frames.some((frame) => isExtensionSource(frame.filename))) {
    return true;
  }

  // Recoverable hydration noise (React #418 / "Hydration failed because the
  // server rendered ...") is virtually always the browser mutating the DOM
  // before/during hydration — Chrome's auto-translate (offered to users whose
  // locale differs from the page, e.g. pt-PT visitors on our English-rendered
  // marketing site) and content-injecting extensions rewrite text nodes, which
  // React then reports as a server/client mismatch. It is recoverable (React
  // regenerates the subtree on the client) and is not an app defect.
  //
  // This was previously scoped to `/auth` only, but the same browser behaviour
  // fires everywhere the user navigates — the marketing site (`/`, `/pt`, ...)
  // and the post-login `/projects` landing — so the route guard let real
  // browser noise through to error tracking. Suppress this class globally.
  //
  // NOTE: this only covers the *recoverable* #418/#423 hydration-text class
  // listed in KNOWN_HYDRATION_NOISE_MESSAGES. A genuine, deterministic app
  // hydration bug surfaces as the non-recoverable React #419/#421/#425 ("Text
  // content does not match" / "There was an error while hydrating") which are
  // NOT in that list and still report normally.
  if (isLikelyDomMutationNoise(message)) {
    return true;
  }

  return requestUrl.includes('/auth') && normalizeString(message).includes('runtime.sendMessage');
}

export function shouldIgnoreSentryNoiseEvent(event: {
  message?: unknown;
  environment?: unknown;
  request?: { url?: unknown };
  exception?: {
    values?: Array<{
      value?: unknown;
      stacktrace?: { frames?: Array<{ filename?: unknown }> };
    }>;
  };
}): boolean {
  return shouldIgnoreSentryBrowserNoise(event);
}
