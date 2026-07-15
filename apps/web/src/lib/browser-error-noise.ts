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

// Storage-blocked browser contexts (Safari private mode, sandboxed/cross-origin
// iframes, partitioned storage, some in-app WebViews) reject the
// `window.localStorage` / `window.sessionStorage` accessor READ itself with a
// `SecurityError: Failed to read the 'localStorage' property from 'window':
// Access is denied for this document.` — distinct from the #4529 null-access
// `TypeError` class (where the accessor resolves to `null`). The managed-storage
// layer (`getLocalStorage`/`getSessionStorage`) wraps the accessor in try/catch
// and returns null on throw, so call sites routed through it are safe; but a
// direct `window.localStorage` read elsewhere in the bundle bypasses that guard
// and the uncaught `SecurityError` reaches Sentry → Better Stack. Two sibling
// patterns (`09b9cf65…` / `ac75f0d8…`), 1 occurrence each, 0 identified users,
// 2026-07-12 17:54 UTC, prod — browser-environment noise, not an app defect.
//
// The wording is the browser's OWN access-control throw on the Web Storage
// accessor (never an app-logic TypeError/ReferenceError), so matching the
// canonical `Failed to read the '<storage>' property from 'window'` prefix is
// specific. BUT a first-party call site that reads `window.localStorage`
// directly (bypassing managed-storage) IS actionable — we want to know which
// call site to fix — so a NEGATIVE guard preserves any event whose stack
// carries a resolved first-party `apps/web/src/…` frame (sourcemap-de-minified).
// Only events with NO resolved first-party frame (third-party / extension /
// injected / unresolved-minified-chunk / frameless captures) are dropped.
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list —
// that gate has no frame context, so a bare-string match there would swallow the
// actionable first-party case the negative guard exists to preserve. The
// frame-aware `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`)
// is the only safe gate.
const STORAGE_SECURITY_ERROR_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Failed to read the 'localStorage' property from 'window'/,
  /^Failed to read the 'sessionStorage' property from 'window'/,
];

// A de-minified first-party source frame: Sentry's sourcemap resolution
// rewrote the raw `_next/static/chunks/…` filename back to the original
// `apps/web/src/…` source path (with or without an `app:///` origin prefix).
// A throw from such a frame originates in our own code, so it is actionable.
function isFirstPartyResolvedSource(filename: unknown): boolean {
  return normalizeString(filename).includes('apps/web/src/');
}

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

// Paper Shaders (`@paper-design/shaders-react`) null-WebGL-context crash class.
// On GPUs/browsers without working WebGL2 (context loss, blacklisted driver,
// stripped WebView, headless renderer), Paper Shaders' shader-mount
// `useEffect`/rAF callback reaches a WebGL2 context that has become `null` and
// calls a WebGL API method on it → `TypeError: Cannot read properties of null
// (reading '<method>')`. The throw happens INSIDE an async callback, so it
// ESCAPES the `<ShaderSafe>` React error boundary (which only catches
// render-phase throws via `getDerivedStateFromError`) → global error → Sentry
// → Better Stack. The two observed null-context method names are:
//   - `getSupportedExtensions`  (Better Stack pattern `34127fa4…`, call site
//                                `new b2` in chunk `c76173f0.…`, prod, 2 occ.)
//   - `getAttribLocation`       (the known sibling already documented in
//                                `shader-safe.tsx`'s probe rationale).
// These are WebGL2 context method names — they are NEVER called from
// first-party app code (only from Paper Shaders' library internals), so the
// message wording alone is specific enough to safely classify as noise without
// a chunk-frame anchor (unlike the generic old-browser SyntaxError class). The
// matching is exact-substring on the canonical `Cannot read properties of null
// (reading '<method>')` (V8) and `Cannot read property '<method>' of null`
// (old JSC) forms, with `TypeError: ` / `Error: ` /
// `Unhandled promise rejection: ` wrappers stripped so all capture paths
// (window.onerror, onunhandledrejection, Sentry exception) classify
// consistently. `shouldIgnore*` here is the leak-path backstop for the throws
// that still escape `<ShaderSafe>` after a context-loss event; the
// `supportsWebGL2()` probe in `shader-safe.tsx` is the primary guard that
// degrades to the fallback BEFORE the throw.
const PAPER_SHADER_NULL_CONTEXT_NOISE_PATTERNS = [
  "Cannot read properties of null (reading 'getSupportedExtensions')",
  "Cannot read properties of null (reading 'getAttribLocation')",
  "Cannot read property 'getSupportedExtensions' of null",
  "Cannot read property 'getAttribLocation' of null",
] as const;

// Old-browser / stripped-down-WebView minified-chunk parse failures. When a
// browser that cannot parse modern minified JS (old Safari/iOS, legacy Android
// WebView, in-app browsers, mail-client preview WebViews) tries to evaluate a
// Next.js `_next/static/chunks/…` bundle, it throws a parse-time `SyntaxError`
// — `Unexpected token '='` / `'('` / `'{'` (V8/SpiderMonkey), `Invalid or
// unexpected token` (V8), or `Cannot use import statement outside a module`
// (V8, when an ES-module chunk is loaded as a classic script) — failing the
// whole chunk for that visitor. These are NOT product bugs: the browser is
// simply incompatible with the shipped syntax. They are 1–2 occurrences each,
// 0 identified users, all from `app:///_next/static/chunks/…` frames.
//
// The message prefixes are GENERIC (a real `new Function('…')` / `eval('…')`
// eval bug in first-party app code throws the same wording), so matching on
// message alone would swallow real app SyntaxErrors. Require BOTH the message
// prefix AND a minified-chunk source (`_next/static/chunks/` or a `?dpl=dpl_…`
// deploy hash). Parse failures happen at raw chunk load time, BEFORE Sentry's
// sourcemap resolution, so the frame filename stays as the raw chunk path —
// a genuine first-party eval bug de-minifies to `apps/web/src/…` and is never
// hidden. `SyntaxError: ` / `Error: ` / `Unhandled promise rejection: ` wrappers
// are stripped before matching so all capture paths (window.onerror,
// onunhandledrejection, Sentry exception) classify consistently.
const OLD_BROWSER_SYNTAX_PARSE_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Unexpected token\b/,
  /^Invalid or unexpected token$/,
  /^Cannot use import statement outside a module$/,
];

// Android System WebView native-bridge instrumentation noise. The Android
// WebView injects a synthetic `app://navigation_performance_logger_android`
// script that records navigation timing (FBNavResponseStart / FBNavDomContent-
// Loaded / …) and ships it back to its native Java bridge via
// `sendDataToNative` → `postMessage`. The bridge holds only a WEAK reference
// to its Java object, so once that object is garbage-collected — page
// navigation, WebView teardown, or the host in-app browser (Threads/Barcelona,
// Facebook, Instagram, …) dismissing the tab — the next `postMessage` throws
// `Error invoking postMessage: Java object is gone`. This is the WebView's OWN
// instrumentation, never first-party code: `app://navigation_performance_logger_android`
// is a synthetic source injected by the System WebView (NOT an `app:///_next/…`
// bundle frame and NOT a de-minified `apps/web/src/…` frame), and
// `sendDataToNative` / `sendJsBlockingTimeMessage` are its internal functions.
// Sentry's `BrowserApiErrors` integration auto-wraps `addEventListener` on
// `EventTarget`, captures the throw, and leaks it to Better Stack as a global
// error. Seen once (pattern `e6a45fe4…`, 1 occurrence, 0 identified users,
// 2026-07-12 19:31:47 UTC) from a Threads (Barcelona) in-app WebView on Android
// 14 / Chrome 149 visiting the marketing homepage (`https://kortix.com/`,
// referer `https://l.threads.com/`).
//
// The message wording is generic enough that a genuine first-party
// `window.postMessage` failure could conceivably share it, so — like the
// stale-webpack-runtime and old-browser-SyntaxError classes — this is anchored
// on BOTH the exact message AND a frame whose filename is the Android
// navigation-performance-logger bridge source. A real app `postMessage` error
// throws inside an `app:///_next/…` chunk (or a de-minified `apps/web/src/…`
// frame), never from `app://navigation_performance_logger_android`, so it keeps
// reporting. Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors`
// list — that gate has no frame context, so a bare-string match there could
// swallow a real first-party postMessage failure; the frame-aware `beforeSend`
// hook (which calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const ANDROID_WEBVIEW_NATIVE_BRIDGE_POSTMESSAGE_NOISE_MESSAGES = [
  'Error invoking postMessage: Java object is gone',
] as const;

const ANDROID_NAV_PERF_LOGGER_FRAME_SOURCE = 'app://navigation_performance_logger_android';

function isAndroidNavPerfLoggerFrame(filename: unknown): boolean {
  return normalizeString(filename) === ANDROID_NAV_PERF_LOGGER_FRAME_SOURCE;
}

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

// TronLink (Tron blockchain wallet) browser-extension injected-script noise.
// The TronLink extension injects a content script
// (`app:///injected/injected.js`, function `BI`) that wraps a page object
// (e.g. `window`) in a Proxy and exposes a `tronlinkParams` property for its
// dapp provider. When the extension's own injected code — or another on-page
// script — attempts a `set` on that proxied object and the trap declines the
// assignment (returns falsish), the engine throws
// `TypeError: 'set' on proxy: trap returned falsish for property 'tronlinkParams'`
// (V8) / `proxy set handler returned false for property 'tronlinkParams'`
// (SpiderMonkey). The throw originates INSIDE the extension's injected script,
// never in first-party app code: `tronlinkParams` is a TronLink-private
// property our app never touches. Better Stack pattern `951c1a31…`, Kortix
// Frontend (prod, application_id 2346967), 2 occurrences, 0 identified users,
// first/last 2026-07-12, call site `app:///injected/injected.js` function `BI`.
//
// The `'set' on proxy: trap returned falsish for property '<X>'` wording is a
// GENERIC Proxy `set`-trap failure that legitimate first-party Proxy users
// (MobX / Immer / Zustand middleware / a hand-rolled `new Proxy(...)` guard)
// can also throw when their `set` trap returns `false`. Matching on message
// alone would swallow those real app Proxy bugs. Require BOTH the
// TronLink-specific property name AND an injected/extension frame/source so a
// real first-party Proxy `set` failure keeps reporting.
const TRONLINK_PROXY_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  // V8 (Chrome/Edge/Opera): the observed production wording.
  /'set' on proxy: trap returned falsish for property 'tronlinkParams'/,
  // SpiderMonkey (Firefox): different engine, same TronLink property.
  /proxy set handler returned false for property 'tronlinkParams'/,
]

function isTronLinkInjectedSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return /^app:\/\/\/injected\/injected\.js$/.test(normalized);
}

// EVM-wallet-extension injected `inpage.js` stream EventEmitter noise. EVM
// wallet extensions (MetaMask and derivatives — Rabby, Bifrost, …) inject a
// content script as `app:///inpage.js` whose provider stream is built on
// `@metamask/post-message-stream`'s `ExtendedBroadcastMessage` (an
// EventEmitter subclass). During extension init / port-teardown races the
// underlying stream/port object is `undefined`, so an `.addListener` /
// `.emit` call on it throws
//   `TypeError: Cannot read properties of undefined (reading 'addListener')`
//   `TypeError: Cannot read properties of undefined (reading 'emit')`
// INSIDE `app:///inpage.js` — never in first-party code. The observed frames
// are `?` / `fulfilled` / `ExtendedBroadcastMessage.<anonymous>`, all in
// `app:///inpage.js`. `app:///inpage.js` is the extension's synthetic
// content-script source (NOT an `app:///_next/…` bundle frame and NOT a
// de-minified `apps/web/src/…` frame), so it is never a first-party Kortix
// call site. Better Stack patterns `17a0ce67…` (addListener, 21 occ.) and
// `3a6b00dc…` (emit, 4 occ.), Kortix Frontend (prod, application_id 2346967),
// 0 identified users, first/last 2026-07-14, call site `app:///inpage.js`,
// request URL `https://kortix.com/` (marketing homepage), Chrome 150.
//
// The `addListener` / `emit` wording is GENERIC — a first-party
// EventEmitter-like bug (Node `EventEmitter`, `mitt`, `nanoevents`, a
// hand-rolled emitter, or any object exposing `addListener`/`emit`) throws
// the SAME wording, so matching on message alone would swallow real app
// bugs. Require BOTH one of the exact message markers AND an
// `app:///inpage.js` injected-source frame (or an extension-origin frame) so
// a real first-party `.addListener`/`.emit` TypeError keeps reporting.
// Returns false when there is no source anchor at all (can't confirm
// extension origin — keep reporting rather than swallow a possible app bug).
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list
// — that gate has no frame context, so a bare-string match there could
// swallow a real first-party emitter TypeError; the frame-aware `beforeSend`
// hook (which calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const INPAGE_WALLET_STREAM_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  // V8 (Chrome/Edge/Opera): the observed production wording.
  /Cannot read properties of undefined \(reading 'addListener'\)/,
  /Cannot read properties of undefined \(reading 'emit'\)/,
  // Old JSC (Safari < …): "Cannot read property 'addListener' of undefined"
  // / "'emit' of undefined" — different engine, same wallet-extension class.
  /Cannot read property 'addListener' of undefined/,
  /Cannot read property 'emit' of undefined/,
];

function isInpageWalletInjectedSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return /^app:\/\/\/inpage\.js$/.test(normalized);
}

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

/**
 * Whether a Sentry / window.onerror event is the storage-blocked
 * `SecurityError: Failed to read the 'localStorage'/'sessionStorage' property
 * from 'window'` class — the browser rejecting the Web Storage accessor READ
 * itself in a storage-blocked context (Safari private mode, sandboxed/
 * cross-origin iframe, partitioned storage, some in-app WebViews). Distinct
 * from #4529's null-access `TypeError` class. Requires the canonical
 * `Failed to read the '<storage>' property from 'window'` message prefix, AND
 * a NEGATIVE guard: if any frame (or the window.onerror filename) resolves to
 * a de-minified first-party `apps/web/src/…` source, the event keeps reporting
 * — that means our own code is reading `window.localStorage` directly
 * (bypassing managed-storage) and is actionable to fix. Only events with NO
 * resolved first-party frame are dropped. See
 * `STORAGE_SECURITY_ERROR_NOISE_PATTERNS` for the full rationale.
 */
export function isStorageSecurityErrorNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!STORAGE_SECURITY_ERROR_NOISE_PATTERNS.some((re) => re.test(stripped))) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party frame means our own code is the
  // direct-access culprit — keep reporting so the call site can be fixed.
  return !sources.some(isFirstPartyResolvedSource);
}

// Sentry events whose exception carries NO message ("No error message" in
// Better Stack) and whose stack frames are ALL unresolved minified chunk
// frames (`?` function, no source line) inside our own browser bundle. These
// are unactionable: there is no message to triage and no resolvable source
// location to fix, so they only pollute error tracking. Better Stack surfaces
// them as "No error message" with a `?` call site — e.g. production patterns
// `a81b7cd3…` (count 11) and `576172fbd8…` (count 2), both in chunk
// `21544-ac9e889808bbe0af.js`, 0 identified users, last 2026-07-12. The throw
// is a `Promise.reject(<non-Error>)` / stripped-message / unresolved-frame
// class — NOT the storage-disabled-WebView TypeError class de-noised by #4529
// (those carry a non-empty `null.getItem` TypeError message that this guard
// never touches; an empty-message exception is incompatible with #4529's
// message-string matcher).
//
// A real first-party regression — `throw new Error()` /
// `Promise.reject(new Error())` in our own code — keeps reporting: its frames
// resolve (via uploaded sourcemaps) to a real source file:line, so the
// "any resolved frame" negative guard preserves the event. Only events with
// NEITHER a message NOR a single resolvable frame are dropped.
function isFrameUnresolved(frame: {
  filename?: unknown;
  function?: unknown;
  lineno?: unknown;
}): boolean {
  const fn = normalizeString(frame.function).trim();
  const lineno = typeof frame.lineno === 'number' ? frame.lineno : 0;
  return (fn === '' || fn === '?') && lineno <= 0;
}

/**
 * Whether a Sentry event is the unactionable "No error message" + unresolved
 * minified-chunk-frame class from our browser bundle — empty exception value
 * AND every frame an unresolved (`?` function, no line) `_next/static/chunks`
 * frame. Real errors (non-empty message, or any resolvable frame, or any
 * non-browser-bundle frame) are never matched. See
 * `isEmptyMessageUnresolvedBrowserChunkNoise` for the full rationale.
 */
export function isEmptyMessageUnresolvedBrowserChunkNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown; lineno?: unknown }>;
}): boolean {
  // Negative guard #1: a real, actionable message always reports.
  if (normalizeString(input.message).trim() !== '') {
    return false;
  }
  const frames = input.frames ?? [];
  // No frames at all → can't confirm it's our browser chunk; keep reporting
  // rather than blanket-dropping frameless events of unknown origin.
  if (frames.length === 0) {
    return false;
  }
  // Negative guard #2: any non-browser-bundle frame (extension / injected /
  // third-party / cross-origin) → keep; don't hide non-app noise here.
  if (!frames.every((frame) => isBrowserBundleSource(frame.filename))) {
    return false;
  }
  // Negative guard #3: any resolvable frame (real source line via sourcemap,
  // or a named function) → an actionable error; keep it.
  if (frames.some((frame) => !isFrameUnresolved(frame))) {
    return false;
  }
  return true;
}

export function isExtensionSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return EXTENSION_PROTOCOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isInjectedAppSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return INJECTED_APP_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Whether a Sentry / window.onerror event is the TronLink browser-extension
 * injected-Proxy `set`-trap noise class: a `'set' on proxy: trap returned
 * falsish for property 'tronlinkParams'` `TypeError` thrown from the
 * extension's own injected script (`app:///injected/injected.js`) or an
 * extension-origin frame. TronLink wraps a page object in a Proxy and exposes
 * `tronlinkParams` for its dapp provider; the throw is in the extension, never
 * in first-party app code. Requires BOTH the TronLink-specific property name
 * AND an injected/extension source so a real first-party Proxy `set` failure
 * (MobX/Immer/Zustand/hand-rolled Proxy) keeps reporting. Returns false when
 * there is no source anchor at all (can't confirm extension origin — keep
 * reporting rather than swallow a possible app Proxy bug). See
 * `TRONLINK_PROXY_NOISE_PATTERNS` for the full rationale.
 */
export function isTronLinkProxyNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!TRONLINK_PROXY_NOISE_PATTERNS.some((re) => re.test(stripped))) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  return sources.some(
    (filename) => isTronLinkInjectedSource(filename) || isExtensionSource(filename),
  );
}

/**
 * Whether a Sentry / window.onerror event is the EVM-wallet-extension
 * injected-`inpage.js` stream EventEmitter noise class: a `TypeError` from
 * calling `.addListener` / `.emit` on an `undefined` stream object inside
 * the extension's `app:///inpage.js` content script
 * (`@metamask/post-message-stream`'s `ExtendedBroadcastMessage`). The throw
 * is in the extension's injected code, never in first-party app code.
 * Requires BOTH one of the exact message markers AND an `app:///inpage.js`
 * injected-source frame (or an extension-origin frame) so a real first-party
 * `.addListener`/`.emit` TypeError (Node `EventEmitter` / `mitt` /
 * `nanoevents` / hand-rolled emitter) keeps reporting. Returns false when
 * there is no source anchor at all (can't confirm extension origin — keep
 * reporting rather than swallow a possible app emitter bug). See
 * `INPAGE_WALLET_STREAM_NOISE_PATTERNS` for the full rationale.
 */
export function isInpageWalletStreamNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!INPAGE_WALLET_STREAM_NOISE_PATTERNS.some((re) => re.test(stripped))) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  return sources.some(
    (filename) => isInpageWalletInjectedSource(filename) || isExtensionSource(filename),
  );
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

/**
 * Whether a message is the Paper Shaders (`@paper-design/shaders-react`)
 * null-WebGL-context crash class: a `TypeError` from calling a WebGL2 context
 * method (`getSupportedExtensions` / `getAttribLocation`) on a context that
 * became `null` (context loss, blacklisted GPU, stripped WebView). These fire
 * from Paper Shaders' async shader-mount callback, ESCAPE the `<ShaderSafe>`
 * React error boundary, and reach Sentry/Better Stack as global errors. The
 * method names are WebGL2 API — never called from first-party app code — so the
 * message wording alone is specific enough; no chunk-frame anchor is needed.
 * Never page Better Stack for this class. See
 * `PAPER_SHADER_NULL_CONTEXT_NOISE_PATTERNS` for the full rationale and the
 * `supportsWebGL2()` probe in `shader-safe.tsx` for the primary guard.
 */
export function isPaperShaderNullContextNoise(message: unknown): boolean {
  const stripped = stripErrorWrappers(normalizeString(message));
  return PAPER_SHADER_NULL_CONTEXT_NOISE_PATTERNS.some((pattern) =>
    stripped.includes(pattern),
  );
}

// Strip the canonical `SyntaxError: ` / `Error: ` / `Unhandled promise
// rejection: ` (and stacked) wrappers a browser/Sentry prefixes a throw with,
// so the underlying message can be matched by an anchored pattern regardless
// of which capture path delivered it.
function stripErrorWrappers(message: string): string {
  return message.trim().replace(/^(?:Unhandled promise rejection: )?(?:[A-Za-z]+Error: )?/, '');
}

// A raw Next.js minified chunk source — `_next/static/chunks/…` (the bundled
// JS chunk) or a Vercel `?dpl=dpl_…` deploy-hash URL. Parse-time SyntaxErrors
// in old browsers fire at chunk LOAD time, before Sentry's sourcemap
// resolution, so the frame filename stays as this raw path. A genuine
// first-party eval/`new Function` SyntaxError de-minifies to `apps/web/src/…`
// and is NOT matched here — that is the negative guard.
function isMinifiedChunkSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  if (!normalized) return false;
  return (
    normalized.includes('/_next/static/chunks/')
    || /[?&]dpl=dpl_[A-Za-z0-9]+/.test(normalized)
  );
}

/**
 * Whether an event is the old-browser / stripped-down-WebView minified-chunk
 * parse-failure class: a `SyntaxError` whose message is one of
 * `Unexpected token …`, `Invalid or unexpected token`, or
 * `Cannot use import statement outside a module`, AND whose throwing frame (or
 * window.onerror filename) is a raw `_next/static/chunks/…` / `?dpl=dpl_…`
 * source. Old browsers that cannot parse modern minified JS throw these at
 * chunk load time; the browser is incompatible, not broken. Requiring a
 * minified-chunk source means a real first-party `new Function(...)` /
 * `eval(...)` SyntaxError (de-minified to `apps/web/src/…`) keeps reporting.
 * Never page Better Stack for the old-browser class.
 */
export function isOldBrowserSyntaxParseError(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const message = normalizeString(input.message);
  if (!message) return false;
  const stripped = stripErrorWrappers(message);
  if (!OLD_BROWSER_SYNTAX_PARSE_NOISE_PATTERNS.some((re) => re.test(stripped))) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  return sources.some((filename) => isMinifiedChunkSource(filename));
}

/**
 * Whether an event is the Android System WebView native-bridge
 * `Error invoking postMessage: Java object is gone` noise class: the WebView's
 * injected `app://navigation_performance_logger_android` script calls
 * `sendDataToNative` → `postMessage` on a native Java bridge whose object has
 * been garbage-collected (page navigation / WebView teardown / in-app browser
 * dismiss). This is the WebView's own instrumentation, not first-party code.
 * Requires BOTH the exact message AND a frame whose filename is the Android
 * navigation-performance-logger bridge source, so a genuine first-party
 * `window.postMessage` failure (which throws from an app chunk or a
 * de-minified `apps/web/src/…` frame) keeps reporting. Never page Better Stack
 * for this class. See
 * `ANDROID_WEBVIEW_NATIVE_BRIDGE_POSTMESSAGE_NOISE_MESSAGES` for the full
 * rationale.
 */
export function isAndroidWebViewNativeBridgePostMessageNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (
    !ANDROID_WEBVIEW_NATIVE_BRIDGE_POSTMESSAGE_NOISE_MESSAGES.some(
      (noise) => message === noise,
    )
  ) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  return sources.some((filename) => isAndroidNavPerfLoggerFrame(filename));
}

// iOS WebKit (Safari, Chrome-on-iOS, Google Search App — all WKWebView/JSC)
// stack-overflow noise. When iOS WebKit exhausts its (lower-than-desktop) call
// stack, it surfaces `RangeError: Maximum call stack size exceeded.` through
// `window.onerror` (Sentry mechanism `auto.browser.global_handlers.onerror`)
// with NO usable stack: the single exception frame is the synthetic
// `{ function: '?', filename: 'undefined', lineno: <n> }` placeholder, so
// `call_site_file` is `undefined` and `call_site_function` is `?`. There is no
// source location to triage and no reproduction (the engine truncated the very
// stack that overflowed). Better Stack pattern
// 87ccbef98ea62fbf90df2446141a26b78ba7f928a28642b099d53b40e8613031
// (Kortix Frontend prod, application_id 2346967): 7 occurrences in the
// now-3d inventory, ~30 lifetime, 0 identified users (all anonymous), first
// 2026-04-21 / last 2026-07-14, 100% iOS (Chrome-on-iOS 149/150 + Google
// Search App 415/425), across 7 different releases spanning 2.5 months — i.e.
// browser/engine noise on iOS, NOT a deterministic app regression (which would
// spike on one release across all browsers with identified users). Fires on the
// marketing site (`/`, `/auth`) AND post-login surfaces (`/projects/…`,
// `/projects/…/sessions/…`), so no route guard contains it.
//
// `RangeError: Maximum call stack size exceeded.` is ALSO the exact message a
// real first-party infinite recursion produces — so this matcher is anchored on
// BOTH the canonical message AND the absence of ANY resolvable source location
// (every frame's filename is empty or the literal `"undefined"` placeholder, and
// the window.onerror filename is empty/`undefined`). A real app recursion, even
// truncated, surfaces with at least one real chunk/URL frame
// (`app:///_next/static/chunks/…`, `https://…`, or a de-minified
// `apps/web/src/…` frame) and is preserved by the negative guard. Only the
// frameless synthetic-`undefined` global-onerror capture is dropped.
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list —
// that gate has no frame context, so a bare-string match there would swallow a
// real RangeError recursion; the frame-aware `beforeSend` hook (which calls
// `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
// React #185 = "Maximum update depth exceeded" — the canonical React infinite-
// setState-loop error. The `@embedpdf/plugin-tiling` `TilingLayer` React
// component (used by `apps/web/src/components/ui/extend/pdf-viewer.tsx`'s
// `<TilingLayer>`) subscribes to the tiling plugin's `onTileRendering` event
// and calls `setTiles(event.tiles[pageIndex] ?? [])` on every emission. Under
// a rapid zoom/scroll burst the tiling plugin emits `onTileRendering`
// synchronously inside the React commit phase (a tile render resolves
// synchronously from cache and re-emits), so `setTiles` is called during
// commit → re-render → `TileImg` re-renders → `renderTile` → `onTileRendering`
// → `setTiles` → … → React's 50-nested-update guard trips React #185. The
// throw is INSIDE @embedpdf's bundled `TilingLayer`/`TileImg` (frame
// `Object.r [as onTileRendering]` in a `_next/static/chunks/…` bundle), never
// in first-party `apps/web/src/…` source. Better Stack pattern
// 366115d4c931a6352fe8f334ff1b366f6d4b2ce9c192769ac681831354521e30
// (Kortix Frontend prod, application_id 2346967): 1 occurrence, 0 identified
// users, 2026-07-15 09:36:41 UTC, route `/projects/:id/sessions/:sessionId`,
// Chrome 142 / Windows 10. A transient third-party render loop, not a
// deterministic app regression (single occurrence, no identified users, no
// first-party frame, no spike on a release across browsers).
//
// React #185 is ALSO the exact message a REAL first-party infinite-setState
// loop produces, so this matcher is anchored on BOTH the #185 message AND a
// frame whose function is `onTileRendering` (the @embedpdf tiling subscription
// callback — never present in first-party code), AND a NEGATIVE guard: if any
// frame resolves to a de-minified first-party `apps/web/src/…` source, the
// event keeps reporting — that means our own component is the looping culprit
// and is actionable to fix. A real first-party #185 surfaces with a resolved
// `apps/web/src/…` frame (or at least no `onTileRendering` frame) and is
// preserved; a #185 from a DIFFERENT third-party lib (no `onTileRendering`
// frame) is preserved too. Only the @embedpdf-tiling #185 class is dropped.
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list —
// that gate has no frame context, so a bare `#185` match there would swallow a
// real first-party setState loop; the frame-aware `beforeSend` hook (which
// calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const REACT_UPDATE_DEPTH_NOISE_PATTERN = /^Minified React error #185\b/;

// The @embedpdf/plugin-tiling `TilingLayer` subscription callback frame. The
// function name `onTileRendering` is the tiling plugin's own event name (see
// `@embedpdf/plugin-tiling`'s `TilingLayer` → `tilingProvides.onTileRendering`);
// it never appears in first-party `apps/web/src/…` source, so its presence is a
// specific third-party anchor.
const EMBEDPDF_TILING_CALLBACK_FRAME_MARKER = 'onTileRendering';

function frameMatchesEmbedPdfTilingCallback(
  frame: { function?: unknown } | undefined,
): boolean {
  return normalizeString(frame?.function).includes(
    EMBEDPDF_TILING_CALLBACK_FRAME_MARKER,
  );
}

const STACK_OVERFLOW_NOISE_PATTERN = /^Maximum call stack size exceeded\.?$/;

// A frame/filename that points at a REAL source location: non-empty AND not the
// literal `"undefined"` placeholder the global-onerror capture uses when the
// engine could not produce a stack. A real chunk (`app:///_next/…`), a URL
// (`https://…`), or a de-minified `apps/web/src/…` path all qualify; the
// synthetic `{ filename: 'undefined' }` frame does not.
function isResolvableFrameSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return normalized !== '' && normalized !== 'undefined';
}

/**
 * Whether a Sentry / window.onerror event is the iOS-WebKit stack-overflow
 * noise class: a `RangeError: Maximum call stack size exceeded.` captured via
 * `window.onerror` with NO resolvable source location (every frame's filename
 * is empty or the literal `"undefined"` placeholder). iOS WebKit surfaces a
 * stack overflow this way because it truncated the very stack that overflowed;
 * there is nothing to triage or fix. A real first-party (or third-party)
 * recursion surfaces with at least one real chunk/URL/`apps/web/src/…` frame
 * and is preserved by the negative guards — only the frameless
 * synthetic-`undefined` capture is dropped. See
 * `STACK_OVERFLOW_NOISE_PATTERN` for the full rationale.
 */
export function isUnresolvableStackOverflowNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  if (!STACK_OVERFLOW_NOISE_PATTERN.test(stripErrorWrappers(normalizeString(input.message)))) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame → our own
  // code is recursing; keep reporting so the call site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  // Negative guard #2: any resolvable source location (real chunk/URL/named
  // file) → an actionable error (app or third-party recursion) with a real
  // stack; keep reporting. Only the frameless synthetic-`undefined`
  // global-onerror capture remains → iOS-WebKit stack-overflow noise.
  if (sources.some(isResolvableFrameSource)) {
    return false;
  }
  return true;
}

/**
 * Whether a Sentry exception is the `@embedpdf/plugin-tiling` `TilingLayer`
 * React #185 "Maximum update depth exceeded" render-loop class: a
 * `Minified React error #185` thrown from inside the tiling plugin's
 * `onTileRendering` subscription callback (frame `Object.r [as
 * onTileRendering]` in a `_next/static/chunks/…` bundle) with NO resolved
 * first-party `apps/web/src/…` frame. The tiling plugin re-emits
 * `onTileRendering` synchronously during the React commit phase under a rapid
 * zoom/scroll burst, so its `setTiles` runs during commit → re-render →
 * `renderTile` → re-emit → React's 50-nested-update guard trips #185. The
 * throw is in third-party bundled code, never first-party. Requires BOTH the
 * #185 message AND an `onTileRendering` frame, AND a NEGATIVE guard: if any
 * frame resolves to a de-minified first-party `apps/web/src/…` source, the
 * event keeps reporting (our own component is the looping culprit →
 * actionable). A real first-party #185, or a #185 from a different third-party
 * lib, is never matched. Returns false when there are no frames (can't confirm
 * the tiling anchor — keep reporting). See
 * `REACT_UPDATE_DEPTH_NOISE_PATTERN` for the full rationale.
 */
export function isEmbedPdfTilingReactUpdateDepthNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown } | undefined>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (!REACT_UPDATE_DEPTH_NOISE_PATTERN.test(message)) {
    return false;
  }
  const frames = input.frames ?? [];
  if (frames.length === 0) {
    return false;
  }
  // Negative guard: a resolved first-party frame means our own component is the
  // looping culprit → actionable; keep reporting so the call site can be found.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Anchor: the throw must be inside @embedpdf/plugin-tiling's `onTileRendering`
  // subscription callback. This frame is never present in first-party code, so a
  // real first-party #185 (or a #185 from a different third-party lib) is never
  // matched.
  return frames.some(frameMatchesEmbedPdfTilingCallback);
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

  // Storage-blocked browser contexts (Safari private mode, sandboxed/cross-
  // origin iframe, partitioned storage, some in-app WebViews) reject the
  // `window.localStorage`/`sessionStorage` accessor READ itself with a
  // `SecurityError: Failed to read the '<storage>' property from 'window'`.
  // A direct `window.localStorage` call site that bypasses managed-storage
  // throws this uncaught. Browser-environment noise; drop it UNLESS the stack
  // carries a resolved first-party `apps/web/src/…` frame (our own code is the
  // culprit → actionable). See `isStorageSecurityErrorNoise`.
  if (isStorageSecurityErrorNoise({ message, filename: input.filename })) {
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

  // Paper Shaders null-WebGL-context crash class — a WebGL2 context method
  // (`getSupportedExtensions` / `getAttribLocation`) called on a `null`
  // context from Paper Shaders' async shader-mount callback, which escapes
  // the `<ShaderSafe>` error boundary. Decorative-canvas noise on
  // incompatible GPUs; never an app defect.
  if (isPaperShaderNullContextNoise(message)) {
    return true;
  }

  // Old-browser / stripped-down-WebView minified-chunk parse failures
  // (`Unexpected token …`, `Invalid or unexpected token`, `Cannot use import
  // statement outside a module`) from `window.onerror`. The browser cannot
  // parse the modern minified chunk — incompatible, not an app defect.
  // Requires a `_next/static/chunks/` / `?dpl=dpl_…` filename so a real
  // first-party eval/`new Function` SyntaxError keeps reporting.
  if (isOldBrowserSyntaxParseError({ message, filename: input.filename })) {
    return true;
  }

  // Android System WebView native-bridge instrumentation noise — the WebView's
  // injected `app://navigation_performance_logger_android` script
  // `sendDataToNative` → `postMessage` to a GC'd Java bridge object. Requires
  // BOTH the exact message AND the Android bridge frame/filename, so a real
  // first-party `window.postMessage` failure keeps reporting.
  if (
    isAndroidWebViewNativeBridgePostMessageNoise({
      message,
      filename: input.filename,
    })
  ) {
    return true;
  }

  if (isInjectedAppSource(input.filename)) {
    return true;
  }

  // TronLink browser-extension injected-Proxy `set`-trap noise — the
  // extension's `injected.js` wraps a page object in a Proxy and a `set` on
  // `tronlinkParams` is declined. Requires BOTH the TronLink property name AND
  // an injected/extension source so a real first-party Proxy `set` failure
  // keeps reporting. See `isTronLinkProxyNoise`.
  if (isTronLinkProxyNoise({ message, filename: input.filename })) {
    return true;
  }

  // EVM-wallet-extension injected-`inpage.js` stream EventEmitter noise —
  // MetaMask/derivatives' `app:///inpage.js` (`ExtendedBroadcastMessage`)
  // calls `.addListener` / `.emit` on an `undefined` stream during init/tear-
  // down races. Requires BOTH the exact message AND an `app:///inpage.js` /
  // extension source so a real first-party emitter TypeError keeps reporting.
  // See `isInpageWalletStreamNoise`.
  if (isInpageWalletStreamNoise({ message, filename: input.filename })) {
    return true;
  }

  // iOS-WebKit stack-overflow noise — `RangeError: Maximum call stack size
  // exceeded.` from `window.onerror` with NO resolvable source location (the
  // engine truncated the very stack that overflowed). Requires the canonical
  // message AND no real frame/filename so a real first-party recursion that
  // carries a chunk/source frame keeps reporting. See
  // `isUnresolvableStackOverflowNoise`.
  if (isUnresolvableStackOverflowNoise({ message, filename: input.filename })) {
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

  // Storage-blocked browser contexts (Safari private mode, sandboxed/cross-
  // origin iframe, partitioned storage, some in-app WebViews) reject the
  // `window.localStorage`/`sessionStorage` accessor READ itself with a
  // `SecurityError: Failed to read the '<storage>' property from 'window'`.
  // A direct `window.localStorage` call site that bypasses managed-storage
  // throws this uncaught. Browser-environment noise; drop it UNLESS the stack
  // carries a resolved first-party `apps/web/src/…` frame (our own code is the
  // culprit → actionable). See `isStorageSecurityErrorNoise`.
  if (isStorageSecurityErrorNoise({ message, frames })) {
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

  // Paper Shaders null-WebGL-context crash class — a WebGL2 context method
  // (`getSupportedExtensions` / `getAttribLocation`) called on a `null`
  // context from Paper Shaders' async shader-mount callback, which escapes
  // the `<ShaderSafe>` error boundary and reaches Sentry as a global error.
  // Decorative-canvas noise on incompatible GPUs; never an app defect.
  if (isPaperShaderNullContextNoise(message)) {
    return true;
  }

  // Old-browser / stripped-down-WebView minified-chunk parse failures
  // (`Unexpected token …`, `Invalid or unexpected token`, `Cannot use import
  // statement outside a module`) thrown when an incompatible browser tries to
  // evaluate a modern `_next/static/chunks/…` bundle. Requires a chunk frame
  // so a real first-party `new Function(...)` / `eval(...)` SyntaxError
  // (de-minified to `apps/web/src/…`) keeps reporting. NOTE: deliberately NOT
  // added to `sentry.client.config.ts`'s `ignoreErrors` list — that gate has
  // no frame context, so a bare-string match there would swallow real app
  // SyntaxErrors. The `beforeSend` hook (which calls this helper) is the only
  // safe gate because it can anchor on the chunk frame.
  if (isOldBrowserSyntaxParseError({ message, frames })) {
    return true;
  }

  // Android System WebView native-bridge instrumentation noise — the WebView's
  // injected `app://navigation_performance_logger_android` script
  // `sendDataToNative` → `postMessage` to a GC'd Java bridge object, captured
  // by Sentry's `BrowserApiErrors` addEventListener auto-wrapper. Requires BOTH
  // the exact message AND a frame whose filename is the Android bridge source,
  // so a genuine first-party `window.postMessage` failure keeps reporting. Not
  // in `ignoreErrors` (no frame context there).
  if (isAndroidWebViewNativeBridgePostMessageNoise({ message, frames })) {
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

  // "No error message" exceptions whose only frames are unresolved minified
  // chunk frames inside our browser bundle — empty exception value + `?`
  // call site (e.g. chunk 21544 patterns a81b7cd3…/576172fbd8…). There is no
  // message to triage and no resolvable source location to fix, so they are
  // unactionable noise; a real first-party regression keeps reporting because
  // its frames resolve to a source line. Distinct from #4529's
  // storage-disabled-WebView class (non-empty `null.getItem` TypeError). See
  // `isEmptyMessageUnresolvedBrowserChunkNoise`.
  if (isEmptyMessageUnresolvedBrowserChunkNoise({ message, frames })) {
    return true;
  }

  if (frames.some((frame) => isInjectedAppSource(frame.filename))) {
    return true;
  }

  // TronLink browser-extension injected-Proxy `set`-trap noise — the
  // extension's `injected.js` (or an extension-origin frame) declines a `set`
  // on `tronlinkParams`. Requires BOTH the TronLink property name AND an
  // injected/extension frame so a real first-party Proxy `set` failure keeps
  // reporting. See `isTronLinkProxyNoise`.
  if (isTronLinkProxyNoise({ message, frames })) {
    return true;
  }

  // EVM-wallet-extension injected-`inpage.js` stream EventEmitter noise —
  // MetaMask/derivatives' `app:///inpage.js` (`ExtendedBroadcastMessage`)
  // calls `.addListener` / `.emit` on an `undefined` stream during init/tear-
  // down races. Requires BOTH the exact message AND an `app:///inpage.js` /
  // extension frame so a real first-party emitter TypeError keeps reporting.
  // See `isInpageWalletStreamNoise`.
  if (isInpageWalletStreamNoise({ message, frames })) {
    return true;
  }

  // iOS-WebKit stack-overflow noise — `RangeError: Maximum call stack size
  // exceeded.` from Sentry's `auto.browser.global_handlers.onerror` capture
  // with a single synthetic `{ filename: 'undefined' }` frame (the engine
  // truncated the very stack that overflowed). Requires the canonical message
  // AND no resolvable source location so a real first-party recursion that
  // carries a chunk/`apps/web/src/…` frame keeps reporting. See
  // `isUnresolvableStackOverflowNoise`. NOT in `ignoreErrors` (no frame
  // context there).
  if (isUnresolvableStackOverflowNoise({ message, frames })) {
    return true;
  }

  // @embedpdf/plugin-tiling `TilingLayer` React #185 "Maximum update depth
  // exceeded" render loop — the tiling plugin re-emits `onTileRendering`
  // synchronously during the React commit phase under a rapid zoom/scroll
  // burst, tripping React's nested-update guard. Requires BOTH the #185 message
  // AND an `onTileRendering` frame, with a first-party negative guard, so a
  // real first-party setState loop keeps reporting. See
  // `isEmbedPdfTilingReactUpdateDepthNoise`.
  if (isEmbedPdfTilingReactUpdateDepthNoise({ message, frames })) {
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
