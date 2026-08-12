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
// The host name in the browser's throw is the Web Storage global interface
// (`Window`), which different browsers capitalize differently: Chrome emits
// `from 'window'`, Firefox/WebKit emit `from 'Window'`. PR #4674's original
// matcher anchored on the lowercase form only, so the capitalized variants
// recurred in prod (patterns `89b0a8e8…` / `b6927c9d…` / `e8eadc82…` /
// `d010de8a…`, last 2026-07-21, call site `webpack-<hash>.js` function `c` =
// `__webpack_require__` in a storage-blocked context — no resolved first-party
// frame → exactly the shape the negative guard is meant to drop). The `i` flag
// makes the host casing match either browser wording WITHOUT widening the match:
// the storage property name (`'localStorage'` / `'sessionStorage'`) stays
// case-sensitive in the regex and never appears on a non-storage throw, and the
// `Failed to read the '…' property from '…'` frame is the browser's own
// access-control wording (never an app-logic error), so case-folding the host
// token cannot swallow a real first-party error the negative guard preserves.
const STORAGE_SECURITY_ERROR_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Failed to read the 'localStorage' property from 'window'/i,
  /^Failed to read the 'sessionStorage' property from 'window'/i,
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
  // V8/Chromium (Chrome/Edge) wording — the canonical DOM mutation error
  // surfaced when React's reconciler or a portal tries to mutate a DOM node
  // that has been moved/removed by an extension or the browser itself.
  "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
  "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
  // Gecko/Firefox wording for the SAME DOM mutation class — a
  // `HierarchyRequestError` surfaced when Next.js's live-feedback/HMR module
  // (`_next-live/feedback/…`) manipulates a node whose ancestor changed
  // (extension DOM rewrite, devtools overlay, or a React portal moved mid-
  // commit). The `InvalidNodeTypeError` type + "The supplied node is
  // incorrect or has an incorrect ancestor for this operation." message is
  // Gecko's canonical DOM-API phrasing for the same `insertBefore`/
  // `removeChild` race the V8 entries above cover. Better Stack pattern
  // 9e6a70ffdb26ba2ab9f821fe8772f51b082d6a9b0e2c9f50b2130cde0c3e6438
  // (Kortix Frontend prod, application_id 2346967): `InvalidNodeTypeError`,
  // 2 occurrences / 0 identified users, last 2026-08-11 16:37:15 UTC,
  // release `cd9dfccec1fb7e41a6726e9e45fd678cf428cc3a` (v0.12.8 prod), call
  // site function `te` in chunk
  // `app:///_next-live/feedback/913.f924585152f5e22503e7.js?dpl=dpl_…`
  // (Next.js live feedback), request URL a co-worker session page, Firefox
  // 153 on macOS, mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT,
  // `handled:false`). The existing V8/JSC patterns (covering only the
  // `insertBefore`/`removeChild` wording) did NOT match the Firefox wording,
  // so this sibling leaked to Better Stack. Adding the Gecko string to the
  // existing array (no matcher change — `containsKnownPattern` matches it the
  // same way as the V8 entries) is the simplest, lowest-risk fix.
  "The supplied node is incorrect or has an incorrect ancestor for this operation.",
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
// (`apps/api/src/projects/routes/r4.ts:3045` and `channel-bindings.ts:288`, both
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
// request URL `https://kortix.com/projects/377b3ef0-…/sessions/d3d542…`
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
// calls a WebGL API method on it → `TypeError`. The throw happens INSIDE an
// async callback, so it ESCAPES the `<ShaderSafe>` React error boundary (which
// only catches render-phase throws via `getDerivedStateFromError`) → global
// error → Sentry → Better Stack. The two observed null-context method names are:
//   - `getSupportedExtensions`  (Better Stack pattern `34127fa4…` / recurrence
//                                `dfcb336b…`, call site `new b2` in chunk
//                                `c76173f0.…`, prod)
//   - `getAttribLocation`       (the known sibling already documented in
//                                `shader-safe.tsx`'s probe rationale).
// These are WebGL2 context method names — they are NEVER called from
// first-party app code (only from Paper Shaders' library internals), so the
// message wording alone is specific enough to safely classify as noise without
// a chunk-frame anchor (unlike the generic old-browser SyntaxError class). The
// matching covers all five JS-engine / DOM-binding wordings for the same
// null-context bug:
//   - V8 (Chrome/Edge):          `Cannot read properties of null (reading '<m>')`
//   - old JSC (old Safari/iOS):  `Cannot read property '<m>' of null`
//   - SpiderMonkey (Firefox):    `can't access property "<m>"<…>` (the variable
//                                name after the method is library-specific, so
//                                the pattern anchors on the stable method-name
//                                prefix only — see the recurrence
//                                `dfcb336b…` which shipped through PR #4544's
//                                V8/JSC-only filter as
//                                `can't access property "getSupportedExtensions",
//                                this.gl is null`).
//   - modern JSC (Safari / Chrome-on-iOS CriOS, which uses WebKit/JSC rather
//                                than V8): `null is not an object (evaluating
//                                'this.gl.<m>')` — the `this.gl.` token and the
//                                `(evaluating '...')` wrapper are JSC-specific;
//                                the pattern is the exact full message per
//                                method so a generic JSC `null is not an object
//                                (evaluating '<other expr>')` throw does NOT
//                                match (pattern `a8754de5…`).
//   - Gecko (Firefox) DOM-binding: `WebGL2RenderingContext.<m>: Argument 1 is
//                                not an object.` — Firefox's DOM bindings throw
//                                on the method call itself (a DIFFERENT code
//                                path from SpiderMonkey's engine TypeError
//                                above) when the `this` binding is not a valid
//                                object (here the null WebGL2 context). Pattern
//                                `fd773de2…` (Firefox 152 on Android 17,
//                                `getAttribLocation`, marketing homepage).
//   - Paper Shaders library's OWN internal guard: the bare `this.gl is null`
//                                string. This is NOT a JS-engine TypeError and
//                                NOT a Gecko DOM-binding message — it is the
//                                library's OWN explicit `throw new Error(
//                                'this.gl is null')` (or equivalent assertion
//                                message) when its internal state check detects
//                                that `this.gl` (the WebGL2 context it cached at
//                                mount) is `null`. Whereas every other entry is
//                                the JS engine / DOM binding wording the library
//                                triggered by dereferencing the null context,
//                                this is the library's OWN wording — it fires on
//                                engines that DON'T surface a JS-engine
//                                TypeError for the same deref (e.g. some Firefox
//                                / SpiderMonkey builds where the method call is
//                                short-circuited by the library's guard before
//                                the engine ever throws). Pattern `f0c8c422…`
//                                (Firefox 137.0 on Windows 10, Gecko engine,
//                                `/projects/:id` project page, post-v0.12.7).
// `TypeError: ` / `Error: ` / `Unhandled promise rejection: ` wrappers are
// stripped before matching so all capture paths (window.onerror,
// onunhandledrejection, Sentry exception) classify consistently.
// `shouldIgnore*` here is the leak-path backstop for the throws that still
// escape `<ShaderSafe>` after a context-loss event; the `supportsWebGL2()`
// probe in `shader-safe.tsx` is the primary guard that degrades to the fallback
// BEFORE the throw. The probe is engine-agnostic (it just calls
// `ctx.getSupportedExtensions()`, which throws or returns null on any engine),
// so it already prevents the throw at mount for Firefox — the filter backstop
// catches the residual async-context-loss throws that bypass the one-shot probe.
const PAPER_SHADER_NULL_CONTEXT_NOISE_PATTERNS = [
  // V8 (Chrome/Edge).
  "Cannot read properties of null (reading 'getSupportedExtensions')",
  "Cannot read properties of null (reading 'getAttribLocation')",
  // Old JSC (old Safari/iOS).
  "Cannot read property 'getSupportedExtensions' of null",
  "Cannot read property 'getAttribLocation' of null",
  // SpiderMonkey (Firefox) — anchors on the stable method-name prefix; the
  // `, this.gl is null` variable suffix is library-specific and dropped so the
  // pattern matches regardless of which Paper Shaders internal variable holds
  // the null context.
  'can\'t access property "getSupportedExtensions"',
  'can\'t access property "getAttribLocation"',
  // Modern JSC (JavaScriptCore — Safari / Chrome-on-iOS CriOS, which uses
  // WebKit/JSC rather than V8). JSC wraps the offending expression as
  // `null is not an object (evaluating '<expr>')`; the Paper Shaders library
  // accesses the WebGL2 context as `this.gl.<method>`, so the prod wording is
  // `null is not an object (evaluating 'this.gl.getSupportedExtensions')` and
  // the `getAttribLocation` sibling. The `this.gl.` token and the
  // `(evaluating '...')` wrapper are JSC-specific; the stable anchor is the
  // exact full JSC message (per-method), so a generic JSC `null is not an
  // object (evaluating '<other expr>')` throw does NOT match. Seen as pattern
  // `a8754de5…` (1 occurrence, 0 users) from Chrome 150 on iOS 26.5.2 on
  // `/projects/:id/sessions/:sessionId`, the fourth engine variant of this
  // class after V8 (#4544), old JSC, and SpiderMonkey (#5172).
  "null is not an object (evaluating 'this.gl.getSupportedExtensions')",
  "null is not an object (evaluating 'this.gl.getAttribLocation')",
  // Gecko / Firefox DOM-binding wording. When the WebGL2 context is `null` /
  // invalid (context loss, blacklisted GPU, stripped WebView), Firefox's DOM
  // bindings throw on the method call itself with the canonical Gecko DOM-API
  // shape `<Interface>.<method>: Argument 1 is not an object.` — the
  // `Argument 1 is not an object.` is Gecko's standard message for a `this`
  // binding that is not a valid object (here the null WebGL2 context). This is
  // the SAME null-WebGL-context crash class as the V8/JSC/SpiderMonkey entries
  // above, just with Firefox's DOM-API error wording instead of an engine
  // TypeError. Better Stack pattern
  // fd773de23b8dbee3551f1132df1dc048a80307133e1e513ca2422ca2bc4fd29a
  // (Kortix Frontend prod, application_id 2346967): `TypeError`, message
  // `WebGL2RenderingContext.getAttribLocation: Argument 1 is not an object.`,
  // 1 occurrence / 0 identified users, first 2026-08-07 19:34:33 UTC
  // (post-v0.12.5, release `e2540c341c6f43536a7cf0e0b51599e9928f055c`),
  // call site `setupPositionAttribute` in chunk
  // `app:///_next/static/immutable/chunks/24zv25pg_k-nz.js`, request URL
  // `https://kortix.com/` (marketing homepage), browser Firefox 152.0 on
  // Android 17 (Gecko engine), mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT,
  // `handled:false`). The `getSupportedExtensions` sibling is added
  // preemptively — same class, Firefox may emit it too. The
  // `WebGL2RenderingContext.<method>:` prefix is the Gecko DOM-binding's own
  // canonical marker (the interface + method name), never emitted by
  // first-party app code, so the message wording alone is specific enough —
  // same message-only contract as the other engine variants (no chunk-frame
  // anchor, no first-party negative guard). Note: `stripErrorWrappers`'s
  // `[A-Za-z]+Error:` regex does NOT strip the
  // `WebGL2RenderingContext.<method>:` prefix (it contains a `.`), so the
  // pattern is matched verbatim by `.includes()` after the `TypeError: ` /
  // `Unhandled promise rejection: ` wrappers are stripped.
  'WebGL2RenderingContext.getSupportedExtensions: Argument 1 is not an object.',
  'WebGL2RenderingContext.getAttribLocation: Argument 1 is not an object.',
  // Paper Shaders library's OWN internal guard wording — the SIXTH variant of
  // this null-WebGL-context crash class, and the ONLY one that is the library's
  // OWN throw rather than a JS-engine TypeError or a Gecko DOM-binding message.
  // When the library's internal state check detects that `this.gl` (the WebGL2
  // context it cached at mount) is `null` (after a context-loss / GPU-blacklist
  // event, or a stripped WebView that returned `null` from `getContext('webgl2')`
  // and bypassed the `supportsWebGL2()` probe), it throws its OWN message
  // `this.gl is null` directly — NOT a JS-engine `TypeError` from dereferencing
  // the null context, and NOT a Gecko DOM-binding message. This fires on engines
  // that DON'T surface a JS-engine TypeError for the same deref (e.g. some
  // Firefox / SpiderMonkey builds where the library's own guard short-circuits
  // the method call before the engine ever throws). Better Stack pattern
  // f0c8c42213b12122948f4c8307b1eedb6a51afe9072460604e3be14e0277d3f2
  // (Kortix Frontend prod, application_id 2346967): `TypeError`, message
  // `this.gl is null`, 1 occurrence / 0 identified users, first 2026-08-10
  // 14:35:19 UTC (post-v0.12.7), request URL
  // `https://kortix.com/projects/1d0153d2-…` (project page), browser Firefox
  // 137.0 on Windows 10 (Gecko engine), mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT,
  // `handled:false`), 3 frames in chunk
  // `app:///_next/static/immutable/chunks/2_t47hwky1w2m.js` (Paper Shaders
  // library). Message-only contract (no chunk-frame anchor, no first-party
  // negative guard) — same as the other engine variants — because (a) `this.gl
  // is null` is the library's OWN canonical wording, never a coincidental
  // app-logic phrase (no first-party `apps/web/src/…` code holds a `this.gl`
  // field — confirmed by `rg "this\.gl" apps/web/src`), and (b) the unhandled-
  // rejection stack carries only minified `@paper-design/shaders` chunk frames,
  // so a first-party negative guard would never fire for this class anyway. The
  // substring match is specific enough that near-worded first-party null-derefs
  // (`this.foo is null`, `this.context is null`, `this.canvas is null`, …) do NOT
  // match — only the exact `this.gl is null` token does. `stripErrorWrappers`
  // strips `TypeError: ` / `Unhandled promise rejection: ` prefixes, leaving the
  // bare `this.gl is null` to match verbatim.
  'this.gl is null',
] as const;

// Paper Shaders (`@paper-design/shaders-react`) WebGL-unsupported deliberate
// throw — a SIBLING of the null-context crash class above, but a DIFFERENT
// throw. When the library's shader mount detects that WebGL is unavailable
// (a stripped-down/mobile WebView, a headless renderer, a browser with WebGL
// disabled, or a GPU blacklisted at context creation), the library throws its
// OWN deliberate `Error('Paper Shaders: WebGL is not supported in this browser')`
// from its constructor — NOT a null-context `TypeError` from calling a WebGL2
// method on a `null` context (the `getSupportedExtensions` / `getAttribLocation`
// wording covered by `PAPER_SHADER_NULL_CONTEXT_NOISE_PATTERNS` above). The
// `Paper Shaders:` prefix is the library's own canonical marker, so this exact
// message is the library's deliberate signal that the browser cannot render the
// decorative shader; it is an EXPECTED degradation state on WebGL-less browsers,
// never a product bug.
//
// Better Stack pattern
// f1abf79ece48a86faf8eb32cec8bbb6bf270627f9fd5d423fb1ee43b9abcfb23
// (Kortix Frontend prod, application_id 2346967): `Error`, message
// `Paper Shaders: WebGL is not supported in this browser`, 1 occurrence /
// 0 identified users (anonymous), last 2026-07-23 17:26:32 UTC, release
// `470fe6f3c88460212c3b187f6f86fb4ad456c4d6` (v0.10.13), route `/`
// (marketing homepage), mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT global
// unhandledrejection — never reached a React error boundary, `handled:false`).
// Browser: Chrome 150.0.0.0 on Android 10 (mobile), UA
// `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko)
// Chrome/150.0.0.0 Mobile Safari/537.36` — a stripped-down/mobile Android
// browser without WebGL. Stack frames: 2, both minified
// `@paper-design/shaders` chunk frames — NO first-party `apps/web/src/…`
// frame:
//   - `app:///_next/static/chunks/81107-7c84018ef9475be5.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno`
//     function `?` lineno 251 colno 3276
//   - same chunk function `new a` lineno 401 colno 1131  (call_site_function)
//
// The `supportsWebGL2()` probe in `shader-safe.tsx` is the primary guard that
// degrades to the fallback BEFORE this throw fires (it calls
// `getContext('webgl2')` + `getSupportedExtensions()` on a probe canvas and
// treats a `null`/throw as unsupported). But the probe is a one-shot memo that
// runs at first `render` of `<ShaderSafe>`, while the library's own `new a`
// constructor throws synchronously on a browser where WebGL is `null` — and on
// some code paths the probe's result is computed after the library has already
// been dynamically imported and its constructor reached. The residual async
// throw then escapes as an unhandled rejection (the library constructor runs
// inside a dynamic import / `useEffect` that bypasses the React error
// boundary). This matcher is the leak-path backstop for that residual throw,
// the way `isPaperShaderNullContextNoise` is the backstop for the null-context
// `TypeError` class.
//
// The message is the library's OWN canonical string (the `Paper Shaders:`
// prefix is the library's deliberate marker, never emitted by first-party app
// code), so an EXACT-message match is safe — a real first-party
// `throw new Error('Paper Shaders: WebGL is not supported in this browser')`
// regression is vanishingly unlikely AND would de-minify to `apps/web/src/…`
// frames, which the mandatory negative guard below preserves. Unlike
// `isPaperShaderNullContextNoise` (message-only, no negative guard — safe
// because WebGL2 API method names are never called from first-party code),
// this message COULD theoretically be thrown from first-party code, so the
// first-party-frame negative guard MUST run when frames are present. The prod
// event has only minified `81107` chunk frames, so the negative guard does
// not fire for it. A frameless capture with this exact message still
// classifies as noise (the message alone is specific — the `Paper Shaders:`
// library prefix is part of the anchor). `Error: ` / `Unhandled promise
// rejection: ` / `Unhandled promise rejection: Error: ` wrappers are stripped
// before matching so all capture paths (window.onerror,
// onunhandledrejection, Sentry exception) classify consistently. Deliberately
// NOT added to `sentry.client.config.ts`'s `ignoreErrors` list — that gate has
// no frame context, so a bare-string match there could swallow a real
// first-party throw the negative guard exists to preserve; the frame-aware
// `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`) is the
// only safe gate.
const PAPER_SHADER_WEBGL_UNSUPPORTED_NOISE_MESSAGE =
  'Paper Shaders: WebGL is not supported in this browser';

// Canvas `getImageData` out-of-memory noise — a third-party canvas library
// (e.g. a decorative background / hyper-logo animation effect on the marketing
// homepage) called `CanvasRenderingContext2D.getImageData()` and the browser ran
// out of memory allocating the `ImageData` buffer, surfacing as
//   `Failed to execute 'getImageData' on 'CanvasRenderingContext2D': Out of
//    memory at ImageData creation`
// (V8/Chrome wording — a `RangeError`, NOT a `TypeError`). This is TRANSIENT
// browser resource exhaustion: the canvas was too large / the tab was under
// memory pressure / the device is low-RAM, so the engine failed the buffer
// allocation. It is NOT a deterministic code bug — the same canvas renders fine
// on the next visit once memory frees up. The throw fires from a
// third-party library's `addEventListener` callback (Sentry's `BrowserApiErrors`
// integration auto-wraps `addEventListener` on `EventTarget` and captures the
// throw as `handled:false`, UNCAUGHT — it never reached a React error
// boundary), and the stack frames are all minified `_next/static/chunks/…`
// library frames with NO resolved first-party `apps/web/src/…` source.
//
// Better Stack pattern
// b4b4384734b09b411e476591e3f9ac3ad88f110e0be91aae390913038f6844f0
// (Kortix Frontend prod, application_id 2346967): `RangeError`, message
// `Failed to execute 'getImageData' on 'CanvasRenderingContext2D': Out of
// memory at ImageData creation`, 1 occurrence / 0 identified users, last
// 2026-08-07 10:09:13 UTC, release
// `160f0b286f0ad5c53debc343d5e055241694e24d` (v0.12.4 prod), call site
// function `Image.<anonymous>`, call site file
// `app:///_next/static/chunks/0fl4m2af7bsiq.js` (minified), request URL
// `https://kortix.com/` (marketing homepage), browser Chrome 130 on Linux,
// mechanism `auto.browser.browserapierrors.addEventListener` (UNCAUGHT,
// `handled:false`). Stack: 2 frames, both minified third-party canvas library
// chunk frames — NO first-party `apps/web/src/…` frame.
//
// The message is the browser's OWN canonical out-of-memory wording for a
// `CanvasRenderingContext2D.getImageData()` allocation failure (the
// `Failed to execute 'getImageData' on 'CanvasRenderingContext2D':` prefix is
// V8's DOM-bindings exception format; the `Out of memory at ImageData
// creation` suffix is the specific allocation-failure reason). This exact
// string is the browser's, never an app-logic phrase — a real first-party
// `throw new RangeError('…Out of memory at ImageData creation…')` regression
// is vanishingly unlikely AND would de-minify to `apps/web/src/…` frames.
// BUT `getImageData` IS a Canvas 2D API method that first-party code CAN call
// (e.g. an image-processing helper, a screenshot/export path, a pixel-reader),
// so — mirroring `isSafariGenericSecurityErrorNoise` /
// `isOldBrowserDomNullDerefNoise` — the matcher carries a NEGATIVE guard: if
// ANY frame (or the window.onerror `filename`) resolves to a de-minified
// first-party `apps/web/src/…` source path, the event KEEPS reporting (our
// own code is the `getImageData` caller → a real first-party OOM regression
// we want to fix). Only events with NO resolved first-party frame (the prod
// noise shape: all minified third-party canvas library chunk frames, or
// frameless) are dropped. A frameless capture with this exact message still
// classifies as noise — the message alone is the browser's canonical OOM
// wording and is specific enough (the `CanvasRenderingContext2D` +
// `getImageData` + `ImageData creation` tokens together pin this single DOM
// API call site). Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there could swallow a real first-party
// `getImageData` OOM regression the negative guard exists to preserve; the
// frame-aware `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`)
// is the only safe gate. The runtime `window.onerror` gate
// (`shouldIgnoreBrowserRuntimeNoise`) is also wired so a runtime capture with
// the exact message + no first-party `filename` drops.
const CANVAS_GETIMAGE_DATA_OOM_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  // The exact V8/Chrome message. Anchored as a full-match (the trailing
  // `Out of memory at ImageData creation` is the specific OOM reason).
  /^Failed to execute 'getImageData' on 'CanvasRenderingContext2D': Out of memory at ImageData creation$/,
];

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

// Old-browser third-party-library DOM null-deref noise on the marketing
// homepage. Two SIBLING patterns, both `TypeError: Cannot read properties of
// null (reading '<X>')` (V8 wording; old JSC says `Cannot read property '<X>'
// of null`) from minified third-party library internals running on VERY OLD
// browsers hitting the marketing homepage (`https://kortix.com/`):
//
//   Pattern 1 (2 occurrences, last 2026-08-06 11:11:14 UTC):
//     Better Stack pattern
//     e02e022f7433a02c7acdc9ae33c3dd1bdec938eeb694f0bf83d290c1d696d853
//     `Cannot read properties of null (reading 'scrollLeft')`, call site
//     function `measureScroll` in chunk `0d5wqj98qv1e9.js` (minified). User
//     agents: Windows 7 Chrome (very old) + Chrome 95 Linux (very old).
//     Mechanism `auto.browser.global_handlers.onerror` (UNCAUGHT,
//     `handled:false` — never reached a React error boundary).
//
//   Pattern 2 (2 occurrences — sibling, same timestamp):
//     Better Stack pattern
//     8ab4ae816505dc3a17c7b8258e6894b3964ab7d10056afc47477833824fa8648
//     `Cannot read properties of null (reading 'appendChild')`, call site
//     function `ft` in chunk `0foj1ouh5ijrj.js` (minified). Same old UAs, same
//     UNCAUGHT global `onerror`, same marketing homepage.
//
// Classification: browser-compatibility noise. `measureScroll` and `ft` are
// THIRD-PARTY library internals (a smooth-scroll / scroll-measurement library
// and an animation/DOM-manipulation helper respectively), not first-party
// Kortix code — the minified call-site function names (`measureScroll`, `ft`)
// do not appear in `apps/web/src/…` source. The throws happen because very old
// browsers (Win7 Chrome, Chrome 95) have quirkier DOM behavior: a scroll-
// measurement helper reaches for a DOM element that resolved to `null` (the
// element was not in the DOM yet, or the old browser returned `null` from a
// `querySelector`/`getBoundingClientRect` path), then accesses `.scrollLeft` on
// it → `TypeError`. Same for `appendChild`: an animation library calls
// `parent.appendChild(child)` on a `parent` that resolved to `null` in the old
// browser. These are 2 occurrences each, 0 identified users, marketing page
// only — not a product flow, not a deterministic app regression.
//
// `scrollLeft` and `appendChild` are STANDARD DOM API method names that
// first-party React code DOES call (e.g. `apps/web/src/hooks/use-proximity-
// hover.ts` reads `container.scrollLeft`, `apps/web/src/features/workspace/
// project-sidebar/session-title.tsx` sets `el.scrollLeft`, ref-callback
// `appendChild` calls exist in portal/tooltip code), so matching on the bare
// message would swallow a real first-party null-deref regression. The matcher
// therefore requires BOTH the exact V8/old-JSC message AND a NEGATIVE guard:
// if ANY frame (or the window.onerror `filename`) resolves to a de-minified
// first-party `apps/web/src/…` source path, the event KEEPS reporting — that
// means our own code is the null-deref culprit and is actionable to fix. The
// prod events carry only minified `app:///_next/static/chunks/…` chunk frames
// (the third-party library internals) + an `<anonymous>` frame, so the
// negative guard does NOT fire for them. A frameless capture with one of these
// exact messages still classifies as noise: `measureScroll` and the minified
// `ft` are third-party library internals, and the messages are specific
// enough (the DOM method names `scrollLeft`/`appendChild` paired with `null`
// access) that a frameless capture is safe to drop — a real first-party
// `el.scrollLeft` / `parent.appendChild` null-deref almost always has a
// resolvable frame with a stack. Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there would swallow a real first-party
// null-deref regression the negative guard exists to preserve; the frame-aware
// `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`) is the only
// safe gate. The runtime `window.onerror` gate
// (`shouldIgnoreBrowserRuntimeNoise`) is also wired so a frameless onerror
// capture with the exact message + no first-party `filename` drops.
const OLD_BROWSER_DOM_NULL_DEREF_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  // V8 (Chrome/Edge/Opera): the observed production wording for both siblings.
  /^Cannot read properties of null \(reading 'scrollLeft'\)$/,
  /^Cannot read properties of null \(reading 'appendChild'\)$/,
  // Old JSC (old Safari/iOS): `Cannot read property '<X>' of null` — different
  // engine, same old-browser DOM null-deref class.
  /^Cannot read property 'scrollLeft' of null$/,
  /^Cannot read property 'appendChild' of null$/,
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

// Android System WebView native-bridge instrumentation noise — the `postEvent`
// sibling of the `postMessage` class above. Android's Chromium WebView ships a
// `JavaBridge` (the V8↔Java bridge injected into every page) whose
// `postEvent`/`postMessage` thread-hop hands a serialized event to the Java
// side via a WEAK reference to the backing `JavaObject`. When that object is
// garbage-collected — page navigation, WebView teardown, or the host in-app
// browser (Threads/Barcelona, Facebook, Instagram, …) dismissing the tab — the
// next `postEvent` throws `Error invoking postEvent: Java object is gone`.
// This is the WebView's OWN bridge plumbing, never first-party code: there is
// no app chunk frame, no de-minified `apps/web/src/…` frame, and (unlike the
// `postMessage` sibling) frequently NO resolvable frame at all — the throw
// escapes from the GC'd bridge hop with a frameless `<anonymous>` / `?`
// call site (Sentry mechanism
// `auto.browser.global_handlers.onerror`/`onunhandledrejection`).
//
// Better Stack pattern
// a6795db236a92a4f9738698e93a8d7ae4e60dae607cacedccb7ed8bbd225b2d4
// (Kortix Frontend prod, application_id 2346967): 1 occurrence / 0 identified
// users, last_seen 2026-07-20 19:05:34 UTC, call_site_file `<anonymous>`,
// call_site_function `?` — the frameless capture shape. The `postMessage`
// sibling `e6a45fe4…` (PR #4610) carried the synthetic
// `app://navigation_performance_logger_android` frame; this `postEvent` variant
// surfaced frameless, so the bridge-frame-only anchor from #4610 does not
// match it. `Java object is gone` is the canonical Android System WebView
// Java-bridge-GC'd message; it is not raised by app code or by desktop
// Chrome.
//
// The message wording (`Error invoking <method>: Java object is gone`) is
// shared with the `postMessage` sibling and could conceivably be reused by a
// hostile/injected script, so this matcher — like the iOS-WebKit
// stack-overflow frameless-capture class — is anchored on BOTH the exact
// `postEvent` message AND a frameless/injected-WebView origin: it suppresses
// only when there is NO resolvable source location (no app chunk, no URL, no
// de-minified `apps/web/src/…` frame) OR the frame is the synthetic Android
// nav-performance-logger bridge source. A genuine first-party `postEvent` /
// `dispatchEvent` failure throws from an `app:///_next/…` chunk or a
// de-minified `apps/web/src/…` frame and is preserved by the negative guard.
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list
// — that gate has no frame context, so a bare-string match there could
// swallow a real first-party event-dispatch failure; the frame-aware
// `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`) is the only
// safe gate.
//
// --- 2026-08-01 sibling (BS pattern `f50ed590…`, the `setTimeout`-captured
// variant) — TWO ADDITIONAL frame shapes must classify as noise ---
// Better Stack pattern
// f50ed59002e8507f8226d63104e7351416eadbc8eb2532977f70fc55a2807e6b
// (Kortix Frontend prod, application_id 2346967): `Error`, message
// `Error invoking postEvent: Java object is gone`, 1 occurrence / 0 identified
// users, last 2026-08-01 08:35:32 UTC, release
// `c330eda4d96e7aee557618254a86df7d16ba5d9b` (v0.12.0 prod), transaction `/`
// (marketing homepage), URL `https://kortix.com/`, browser Chrome 150.0.7871
// on Android 16 (mobile, UA
// `Mozilla/5.0 (Linux; Android 16; K) AppleWebKit/537.36 (KHTML, like Gecko)
// Chrome/150.0.7871.181 Mobile Safari/537.36`), mechanism
// `auto.browser.browserapierrors.setTimeout` (UNCAUGHT — `handled:false`,
// Sentry's `BrowserApiErrors` integration auto-wraps `setTimeout` and
// captures the throw from the timer callback). Stack (2 frames, BOTH
// `in_app:true`):
//   1. `app:///_next/static/chunks/86784-d4b6544b8ad14b3b.js?dpl=dpl_…`
//      function `u` (the Next.js webpack runtime chunk — the SCHEDULING frame
//      where `setTimeout` was REGISTERED, NOT the throw site)
//   2. `<anonymous>` function `?` (THE THROW SITE — the anonymous setTimeout
//      callback where the GC'd Android WebView `JavaBridge.postEvent` throws)
//
// This is the SAME `postEvent` Android WebView bridge-GC noise class as
// `a6795db2…` (#5181), but surfaced via a DIFFERENT Sentry capture path: the
// `BrowserApiErrors.setTimeout` auto-wrapper records the frame that SCHEDULED
// the timer (the webpack runtime chunk, where `__webpack_require__`'s module
// init code registered a `setTimeout`) as frame #1, and the actual throw site
// (the anonymous callback = the WebView bridge hop) as frame #2 `<anonymous>`.
// The #5181 matcher's negative guard #2 (`isResolvableFrameSource`) rejected
// this event because frame #1 (`app:///_next/…`) is a "resolvable" source, so
// it leaked to Better Stack.
//
// The throw STILL originates at the `<anonymous>` Android WebView bridge hop
// — frame #1 is an INCIDENTAL scheduling frame (where the timer was
// registered), not the throw site. `Java object is gone` is the canonical
// Android System WebView Java-bridge-GC'd message; it is never raised by
// first-party app code or by desktop Chrome, so the `<anonymous>` throw-site
// frame is a specific positive anchor for this class. The fix:
//   1. Treat `<anonymous>` (the canonical Android WebView bridge throw-site
//      frame) as a POSITIVE anchor — a `<anonymous>` / `?` frame is where the
//      GC'd `postEvent` actually throws, never a first-party call site.
//   2. Relax negative guard #2 so an INCIDENTAL webpack-runtime chunk frame
//      (the `BrowserApiErrors.setTimeout` scheduling frame, an `app:///_next/`
//      chunk that is NOT a resolved first-party `apps/web/src/…` path) does NOT
//      veto suppression. The first-party `apps/web/src/…` negative guard #1 is
//      unchanged — a real first-party `postEvent`/`dispatchEvent` regression
//      de-minifies to `apps/web/src/…` and is still preserved.
const ANDROID_WEBVIEW_NATIVE_BRIDGE_POSTEVENT_NOISE_MESSAGES = [
  'Error invoking postEvent: Java object is gone',
] as const;

// The canonical Android WebView `JavaBridge` throw-site frame: `<anonymous>`
// with function `?` (Sentry's placeholder for a frame whose function name was
// stripped during minification). When the `BrowserApiErrors.setTimeout`
// (or `addEventListener`) auto-wrapper captures a `postEvent: Java object is
// gone` throw, the actual throw originates from the anonymous callback (the
// WebView bridge hop), so this frame is the specific positive anchor. A
// first-party `postEvent`/`dispatchEvent` throw surfaces with a NAMED function
// (or a de-minified `apps/web/src/…` filename), never the bare `<anonymous>`
// throw-site shape — so anchoring on `<anonymous>` here is conservative for
// this exact message. (Distinct from the `app://navigation_performance_logger_
// android` synthetic source used by the `postMessage` sibling #4610.)
const ANDROID_WEBVIEW_BRIDGE_THROW_SITE_FRAME = '<anonymous>';

// iOS WebKit (WKWebView) in-app-browser native-bridge instrumentation noise.
// The iOS sibling of the Android System WebView bridge noise above
// (`ANDROID_WEBVIEW_NATIVE_BRIDGE_POST{MESSAGE,EVENT}_NOISE_MESSAGES`). The
// Facebook iOS in-app browser (and iOS WebViews generally — every iOS in-app
// browser is a WKWebView, all running JavaScriptCore/JSC, not V8) injects a
// synthetic `app:///` (note: THREE slashes — distinct from the Android bridge's
// single-slash `app://navigation_performance_logger_android` source) script that
// records navigation/performance timing (`processLargestContentfulPaintEvent`)
// and ships it back to its native bridge via `sendDataToNative` →
// `window.webkit.messageHandlers`. On iOS WebViews where the WebKit
// `messageHandlers` bridge is unavailable — the host app didn't wire it, or the
// page is loading/tearing down — `window.webkit` is `undefined`, so the property
// access `window.webkit.messageHandlers` throws JSC's canonical
// `undefined is not an object (evaluating 'window.webkit.messageHandlers')`.
// This is the WebView's OWN instrumentation, never first-party code: the
// `app:///` frames are the WebView's injected script (NOT an `app:///_next/…`
// bundle frame and NOT a de-minified `apps/web/src/…` frame), and
// `sendDataToNative` / `processLargestContentfulPaintEvent` are its internal
// functions. Sentry's `GlobalHandlers` `onerror` integration captures the throw
// as an UNCAUGHT global error (mechanism
// `auto.browser.global_handlers.onerror`, `handled:false` — it never reaches a
// React error boundary) and leaks it to Better Stack. Better Stack pattern
// 5b94212bc682a1ee1d33d67f6517ec95830c63e1ff8a3779d1700dd6091679eb
// (Kortix Frontend prod, application_id 2346967): 1 occurrence / 0 identified
// users, last_seen 2026-07-27 10:36:24 UTC, release
// `5d47baf11708881f1099cdaa875266944e976a78` (POST-`0.10.16`),
// transaction `/` (marketing homepage), URL `https://kortix.com/?fbclid=…`
// (a Facebook referral), browser `Facebook 571.0.0.55.72` on `iOS (iPhone)
// 26.5.2` (the Facebook in-app browser — an iOS WebView). Stack frames (3, all
// synthetic `app:///` WebView instrumentation — NO first-party
// `apps/web/src/…` frame): `?`, `processLargestContentfulPaintEvent`, and the
// throwing `sendDataToNative` (call_site_function `sendDataToNative`).
//
// The message wording (`undefined is not an object (evaluating
// 'window.webkit.messageHandlers')`) is JSC's canonical TypeError phrasing for
// a property access on `undefined` (here `window.webkit` is undefined). The
// `window.webkit.messageHandlers` token is the STABLE anchor — it names the
// WebKit native-bridge API the WebView instrumentation is trying to reach; it
// is never called from first-party app code. Do NOT match just `window.webkit`
// (too broad — a real first-party `window.webkit.<x>` access, e.g.
// `window.webkit.audioWorklet`, could throw and must stay observable). The
// matcher is anchored on BOTH the EXACT `messageHandlers` message AND a
// POSITIVE frame anchor: at least one frame whose filename is the synthetic
// `app:///` source (the iOS WebView's injected instrumentation — distinct from
// Android's `app://navigation_performance_logger_android`) OR whose function is
// one of the iOS WebView instrumentation internals (`sendDataToNative`,
// `processLargestContentfulPaintEvent`). The function-name anchor is stable
// across deploys (mirroring #5181's `postEvent` function-name anchor). A
// NEGATIVE guard (mandatory — mirrors #5181 / the Paper Shaders matchers): if
// ANY frame resolves to a de-minified first-party `apps/web/src/…` source, the
// event keeps reporting (a real first-party `window.webkit.messageHandlers`
// access regression de-minifies to `apps/web/src/…` and must not be hidden).
// The prod event carries only `app:///` frames, so the negative guard does not
// fire for it. Deliberately NOT added to `sentry.client.config.ts`'s
// `ignoreErrors` list — that gate has no frame context, so a bare-string match
// there could swallow a real first-party `window.webkit.messageHandlers`
// access; the frame-aware `beforeSend` hook (which calls
// `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const IOS_WEBVIEW_WEBKIT_BRIDGE_NOISE_MESSAGE =
  "undefined is not an object (evaluating 'window.webkit.messageHandlers')";

// The iOS WebKit in-app-browser synthetic injected-instrumentation source:
// the bare empty-host `app:///` (THREE slashes, NO path) — the origin shape
// iOS WebViews use for their own injected instrumentation scripts. Distinct
// from (a) the Android bridge's single-slash
// `app://navigation_performance_logger_android` source, AND (b) a first-party
// Next.js bundle frame `app:///_next/static/chunks/…` (which shares the
// `app:///` PREFIX but carries a `_next/…` path). An EXACT match (not a
// prefix) is required so a first-party `app:///_next/…` chunk frame is never
// mistaken for the WebView's bare-source instrumentation.
const IOS_WEBVIEW_INSTRUMENTED_FRAME_SOURCE = 'app:///';

// The iOS WebView instrumentation internal function names — the WebView's own
// navigation/performance-timing plumbing, never present in first-party
// `apps/web/src/…` source. `sendDataToNative` is the bridge-call that throws
// (the prod call_site_function); `processLargestContentfulPaintEvent` is the
// timing recorder that calls into it.
const IOS_WEBVIEW_INSTRUMENTED_FUNCTION_NAMES = new Set([
  'sendDataToNative',
  'processLargestContentfulPaintEvent',
]);

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

const INJECTED_APP_SOURCE_PATTERNS = [
  /^app:\/\/\/scripts\/inpage\.js$/,
  /^app:\/\/\/client_data\/[^/]+\/script\.js$/,
  /^app:\/\/\/embed\/embed\.js$/,
  /^app:\/\/\/injectedScript\.bundle\.js$/,
  // CAPTCHA / anti-bot browser-extension (DataDome, Cloudflare, or similar
  // bot-detection service) injected content script. The extension injects an
  // interceptor script into every page as the synthetic source
  // `app:///content/captcha/mt_captcha/interceptor.js` (the same `app:///`
  // empty-host origin shape as the other injected/extension sources above —
  // distinct from a first-party `app:///_next/…` bundle frame and a
  // de-minified `apps/web/src/…` source path). Its internal `widgetId`
  // configuration race (see `isCaptchaInterceptorNoise`) leaks to Better Stack
  // as a `TypeError: Cannot read properties of undefined (reading 'widgetId')`
  // from a minified extension function (`d`); the throw is in the extension's
  // own injected code, never in first-party Kortix code.
  /^app:\/\/\/content\/captcha\/mt_captcha\/interceptor\.js$/,
] as const;

// Browser userscript-manager (Tampermonkey / Violentmonkey / Greasemonkey /
// FireMonkey) injected-script noise. A userscript-manager extension wraps each
// injected user script in a synthetic `app:///userscript.html?name=<Script>.user.js&id=<uuid>`
// page so it can run in an isolated sandbox with privileged APIs
// (`GM_*` / `GM_` / `unsafeWindow`). The user script executes on every page
// whose URL matches its `@match` / `@include` rules (a `YoutubeDL.user.js`
// download-helper script `@match`s `*://*/*` and runs on `https://kortix.com/`).
// When the script's own logic is buggy — e.g. it calls `JSON.parse()` on a
// value that resolved to `undefined` (an attribute / text node it expected to
// find was absent on our page) — it throws `SyntaxError: "undefined" is not
// valid JSON` as an UNHANDLED promise rejection inside the userscript wrapper.
// Sentry's `GlobalHandlers` `onunhandledrejection` integration captures it,
// and because the throw's frame is the synthetic `app:///userscript.html?…`
// source (NOT an `app:///_next/…` bundle frame and NOT a de-minified
// `apps/web/src/…` frame), it leaks to Better Stack. Better Stack pattern
// 2249441898cd4d7bb679841d57b829b8863c9a4dc1675a88075d794cfd3cd600
// (Kortix Frontend prod, application_id 2346967): 1 occurrence, 0 identified
// users, 2026-07-21 05:08 UTC, `SyntaxError: "undefined" is not valid JSON`,
// call site `JSON.parse` at `<anonymous>`, frames
// `app:///userscript.html?name=YoutubeDL.user.js&id=303c1708-…` (fn `?`, line 1614)
// + `<anonymous>` (`JSON.parse`), mechanism `auto.browser.global_handlers.
// onunhandledrejection`, request URL `https://kortix.com/`, Chrome 150 / Win 10.
// The throw is in the THIRD-PARTY user script's own logic, never in first-party
// app code: `app:///userscript.html` is the userscript-manager's synthetic
// wrapper page (it has the same `app:///` empty-host origin shape as the other
// injected/extension sources above), and `JSON.parse` is a built-in. Our app
// never runs from a `userscript.html` frame.
//
// The `app:///userscript.html` prefix is specific to userscript-manager
// wrappers and never appears on a first-party `app:///_next/…` bundle frame or
// a de-minified `apps/web/src/…` source path (those carry `_next/static/` or
// the `apps/web/src/` path), so anchoring on it is conservative. A real
// first-party `JSON.parse(undefined)` regression throws inside an
// `app:///_next/…` chunk (or a de-minified `apps/web/src/…` frame) and is never
// matched. This mirrors `isInjectedAppSource` / `isExtensionSource`: a
// definitive third-party-injected-source anchor that drops the event.
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list —
// that gate has no frame context, so a bare-string match there would swallow a
// real first-party `JSON.parse` SyntaxError; the frame-aware `beforeSend` hook
// (which calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const USERSCRIPT_MANAGER_FRAME_PATTERN = /^app:\/\/\/userscript\.html\b/;

function isUserscriptManagerInjectedSource(filename: unknown): boolean {
  return USERSCRIPT_MANAGER_FRAME_PATTERN.test(normalizeString(filename));
}

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
];

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

// Browser-extension EIP-1193 wallet-provider "disconnected" rejection of a
// PLAIN OBJECT (not an Error). A wallet extension (e.g. extension id
// `lgmpcpglpngdoalbgeoldeajfclnhafa`) injects an EIP-1193 provider
// (`window.ethereum`) whose content script
// (`chrome-extension://<id>/content-script.js`) rejects pending JSON-RPC
// requests when the provider disconnects, with a plain object of the shape
// `{ code: 4900, message: "The provider is disconnected from all chains.",
// stack: "Error: …\\n    at … (chrome-extension://…/content-script.js)" }`
// (EIP-1193 / EIP-1474 error code 4900 = "provider is disconnected"). Because
// the rejected value is NOT an Error instance, Sentry's GlobalHandlers
// `onunhandledrejection` integration cannot extract a stack from it: it
// serializes the object's own enumerable keys into `extra.__serialized__` and
// sets the exception value to the synthetic
// "Object captured as promise rejection with keys: code, message, stack" with
// NO stacktrace frames. The extension origin therefore lives ONLY in
// `extra.__serialized__.stack`, never in `exception.values[0].stacktrace` — so
// the frame-aware extension-source guards (`isExtensionSource(frame.filename)`,
// `isInpageWalletStreamNoise`, `isTronLinkProxyNoise`) all miss it (there are
// no frames to anchor on). Better Stack pattern
// 0f78b2f8e9efa79fe9b2ea534e275c704f113eafea86bae5470f33174ebacebc, Kortix
// Frontend (prod, application_id 2346967), `UnhandledRejection`, 2
// occurrences, 0 identified users, first 2026-07-06 / last 2026-07-15,
// mechanism `auto.browser.global_handlers.onunhandledrejection`, request URL
// `https://kortix.com/auth`, Chrome 150.
//
// The synthetic "Object captured as promise rejection with keys: …" message is
// Sentry's generic signature for ANY non-Error plain-object rejection — a
// first-party `Promise.reject({ code, message, stack })` would produce the SAME
// signature — so matching on the message alone would swallow a real app bug.
// Require BOTH the synthetic signature AND the serialized rejection's own
// `stack` carrying a browser-extension origin (`chrome-extension://`,
// `moz-extension://`, `safari-web-extension://`, `extension://`), which is
// definitive proof the rejection originated in an extension content script,
// not first-party code. A negative guard preserves any event whose stacktrace
// still resolves to a first-party `apps/web/src/…` frame (our own code rejected
// a plain object that happens to carry an extension stack — actionable).
// Returns false when there is no serialized payload to confirm extension origin
// (keep reporting rather than swallow a possible app plain-object rejection).
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list —
// that gate has no `extra.__serialized__` context, so a bare-string match there
// could swallow a real app plain-object rejection; the frame+payload-aware
// `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`) is the only
// safe gate.
const SYNTHETIC_OBJECT_REJECTION_PATTERN =
  /^Object captured as promise rejection with keys:/;

function extractSerializedRejectionStack(extra: unknown): string {
  if (!extra || typeof extra !== 'object') return '';
  const serialized = (extra as Record<string, unknown>).__serialized__;
  if (!serialized) return '';
  if (typeof serialized === 'string') return serialized;
  if (typeof serialized === 'object') {
    const stack = (serialized as Record<string, unknown>).stack;
    return typeof stack === 'string' ? stack : '';
  }
  return '';
}

/**
 * Whether a Sentry event is the browser-extension wallet-provider
 * plain-object rejection noise class: a synthetic
 * "Object captured as promise rejection with keys: …" exception (Sentry's
 * signature for a non-Error rejection) whose serialized rejection payload
 * (`extra.__serialized__.stack`) traces through a browser-extension content
 * script. EIP-1193 wallet extensions reject pending requests with a plain
 * `{ code, message, stack }` object when the provider disconnects; Sentry
 * cannot extract a stack from a non-Error, so the extension origin appears
 * ONLY in the serialized payload, never in the stacktrace frames. Requires
 * BOTH the synthetic signature AND an extension-origin frame inside the
 * serialized stack so a real first-party `Promise.reject({...})` keeps
 * reporting. See `SYNTHETIC_OBJECT_REJECTION_PATTERN` for the full rationale.
 */
export function isExtensionRejectedObjectNoise(input: {
  message?: unknown;
  extra?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const message = normalizeString(input.message);
  if (!SYNTHETIC_OBJECT_REJECTION_PATTERN.test(message)) {
    return false;
  }
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our own
  // code rejected a plain object — actionable, keep reporting so the call site
  // can be found + fixed.
  const frames = input.frames ?? [];
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  const stack = extractSerializedRejectionStack(input.extra);
  if (!stack) {
    // No serialized payload to confirm extension origin — keep reporting
    // rather than swallow a possible app plain-object rejection.
    return false;
  }
  return EXTENSION_PROTOCOL_PREFIXES.some((prefix) => stack.includes(prefix));
}

// Whether a runtime-captured rejected value (the `reason` of an
// `unhandledrejection` event, or an `error` object) is the browser-extension
// wallet-provider plain-object rejection: a non-Error object whose own `stack`
// string traces through a browser-extension content script. This is the
// runtime-gate mirror of `isExtensionRejectedObjectNoise` (the Sentry `beforeSend`
// gate sees Sentry's synthetic "Object captured as promise rejection …"
// message; the runtime gate sees the raw rejected object, whose `message` is
// the provider's own "The provider is disconnected from all chains." — so the
// synthetic-signature matcher does not apply here). A real Error thrown by app
// code has a stack of app/chunk frames, never an extension content-script
// frame, so anchoring on an extension protocol inside the rejected value's
// `stack` is conservative.
function rejectedObjectHasExtensionStack(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const stack = (value as { stack?: unknown }).stack;
  return (
    typeof stack === 'string'
    && EXTENSION_PROTOCOL_PREFIXES.some((prefix) => stack.includes(prefix))
  );
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
 * `Failed to read the '<storage>' property from 'window'` message prefix (the
 * host name is matched case-insensitively so Chrome's `from 'window'` AND
 * Firefox/WebKit's `from 'Window'` wording both classify), AND a NEGATIVE
 * guard: if any frame (or the window.onerror filename) resolves to a
 * de-minified first-party `apps/web/src/…` source, the event keeps reporting
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
// resolve (via uploaded sourcemaps) to a real `apps/web/src/…` source file
// (Sentry uploads sourcemaps and rewrites the frame filename), so the
// "any resolved first-party source frame" negative guard preserves the event.
// Only events with NEITHER a real message NOR a single resolvable first-party
// source frame are dropped.
//
// --- 2026-07-21 extension (post-0.10.13 recurrence, chunk 21544 again) ---
// Sentry SDK 10.x (`@sentry/nextjs@10.63.0`) changed how it serializes an
// onerror capture whose thrown value has NO `.message`: instead of leaving
// `exception.values[0].value` empty/undefined, it now sets the literal
// placeholder string `"No error message"` there (which is also what Better
// Stack displays). The new production patterns
//   `141dcca3d176082360456b74d56119f59acdf806ae0f3ab1e7e7bd8218bca8d2`
//   (8 occ / 0 users / last 2026-07-20 21:21:55 UTC, dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2)
//   `19ee7c2fe89a3f3302fb8209574d906a7b7c8f04d55746e9b443e9bf078c64ca`
//   (6 occ / 0 users / last 2026-07-21 17:03:18 UTC, dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno)
// are the SAME noise class as #4540 (window.onerror, value-less throw, call
// site the chunk-21544 frame) but the original matcher missed them for TWO
// reasons:
//   1. The placeholder `"No error message"` is a NON-EMPTY string, so the
//      `message.trim() !== ''` negative guard #1 bailed immediately.
//   2. The SDK 10.x frames are mostly NAMED minified functions (`iX`, `iu`,
//      `ib`, `ik`, `oq`, `o_`, `l9`, `l`, `MessagePort.x`) with real linenos,
//      so the "every frame unresolved" negative guard #3 also bailed. The
//      LAST frame (chunk 21544, `?` function, lineno 1) is still unresolved —
//      that's the call-site frame Better Stack surfaces — but the older
//      "all frames must be unresolved" rule no longer holds.
// The fix treats the literal `"No error message"` placeholder as equivalent
// to an empty message (it is Sentry's own "no message" marker, never a real
// app error message), and relaxes the frame guard from "every frame
// unresolved" to "no frame resolves to a first-party `apps/web/src/…` source
// path". The first-party-source negative guard is the load-bearing one: a
// real `throw new Error(...)` / `Promise.reject(new Error(...))` in our own
// code de-minifies to `apps/web/src/…` and is preserved; only events whose
// frames are ALL raw minified chunk paths (sourcemap resolution produced no
// first-party source path) keep being dropped. A non-browser-bundle frame
// (extension / injected / cross-origin) still keeps the event reporting.
//
// The literal placeholder Sentry SDK 10.x writes into
// `exception.values[0].value` when a `window.onerror` capture has no
// `error.message` (the thrown value was a non-Error, or an Error with an
// empty message). It is the SDK's own "no message" marker — never a real
// app error message — so it is equivalent to an empty message for the noise
// matcher. Better Stack displays this exact string as the error's "Message".
const SENTRY_NO_ERROR_MESSAGE_PLACEHOLDER = 'No error message';

function isMessageEmptyOrPlaceholder(message: unknown): boolean {
  const normalized = normalizeString(message).trim();
  return (
    normalized === ''
    || normalized === SENTRY_NO_ERROR_MESSAGE_PLACEHOLDER
  );
}

/**
 * Whether a Sentry event is the unactionable "No error message" + unresolved
 * minified-chunk-frame class from our browser bundle — empty exception value
 * (or the Sentry 10.x `"No error message"` placeholder string) AND every
 * frame a raw `_next/static/chunks` minified-chunk frame with NO resolved
 * first-party `apps/web/src/…` source path. Real errors (a real non-placeholder
 * message, or any frame that sourcemap-resolved to a first-party source path,
 * or any non-browser-bundle frame) are never matched. See
 * `isEmptyMessageUnresolvedBrowserChunkNoise` for the full rationale.
 */
export function isEmptyMessageUnresolvedBrowserChunkNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown; lineno?: unknown }>;
}): boolean {
  // Negative guard #1: a real, actionable message always reports. The Sentry
  // 10.x `"No error message"` placeholder is the SDK's own "no message"
  // marker (a window.onerror capture whose thrown value had no `.message`),
  // NOT a real app error message, so it is treated as empty here.
  if (!isMessageEmptyOrPlaceholder(input.message)) {
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
  // Negative guard #3: any frame that sourcemap-resolved to a real first-party
  // `apps/web/src/…` source path → an actionable error with a fixable call
  // site; keep it. A real `throw new Error(...)` / `Promise.reject(new Error())`
  // in our own code de-minifies to `apps/web/src/…`, so it is preserved.
  // (Sentry SDK 10.x frames may be named minified functions like `iX`/`oq`
  // with real linenos but STILL not resolve to a first-party source path —
  // those are raw chunk frames with no actionable source location, so they
  // do not trip this guard. The load-bearing signal is the resolved
  // first-party source path, not the function-name/lineno resolution.)
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
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
 * Whether a Sentry / window.onerror event originates from a browser
 * userscript-manager (Tampermonkey / Violentmonkey / Greasemonkey / FireMonkey)
 * injected user script — a frame whose filename is the userscript-manager's
 * synthetic `app:///userscript.html?name=<Script>.user.js&id=<uuid>` wrapper
 * page. The user script runs on every `@match`ed page (e.g. a download-helper
 * script `@match`ing a wildcard `https-or-http any-host any-path` rule and
 * running on `https://kortix.com/`); its OWN
 * logic bugs (e.g. `JSON.parse(undefined)` → `SyntaxError: "undefined" is not
 * valid JSON`) surface as unhandled rejections captured by Sentry and leak to
 * Better Stack because the frame is the synthetic wrapper, never first-party
 * code. The `app:///userscript.html` prefix is specific to userscript-manager
 * wrappers and never appears on a first-party `app:///_next/…` bundle frame or
 * a de-minified `apps/web/src/…` source path, so anchoring on it is
 * conservative: a real first-party `JSON.parse` SyntaxError throws inside an
 * app chunk (or a de-minified `apps/web/src/…` frame) and is never matched.
 * See `USERSCRIPT_MANAGER_FRAME_PATTERN` for the full rationale and the
 * production pattern `2249441898…`.
 */
export function isUserscriptManagerNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  return sources.some(isUserscriptManagerInjectedSource);
}

// OneTrust cookie-consent SDK JSON-parse noise. OneTrust
// (`https://onetrust.com`) is a third-party cookie-consent / IAB TCF banner
// vendors inject into pages via a small bootstrap stub
// (`otSDKStub.js?did=<domainId>`) that XHR-fetches the consent configuration
// for the site's domain. When the SDK is misconfigured / the domain ID is
// `undefined` / the consent endpoint returns an empty or truncated body
// (a CORS preflight failure, a 5xx, a network abort, or the page is loaded
// in a stripped-down browser — an old iOS Safari that cannot complete the
// XHR), the stub's `XMLHttpRequest` `onload` handler calls `JSON.parse()` on
// the empty/truncated response and throws the canonical V8/JSC
// `SyntaxError: Unexpected end of JSON input`. The throw originates INSIDE
// the OneTrust SDK's own `otSDKStub.js` script (function `r.onload`), never
// in first-party Kortix code: the `did=undefined` query param is the SDK's
// OWN misconfiguration signal (the domain ID never resolved), and the
// `app:///scripttemplates/otSDKStub.js` source is OneTrust's synthetic
// injected-script origin (the same `app:///` empty-host origin shape as the
// other injected/extension sources — distinct from a first-party
// `app:///_next/…` bundle frame and a de-minified `apps/web/src/…` source
// path). Sentry's `BrowserApiErrors` integration auto-wraps
// `XMLHttpRequest.onload` and captures the throw as `handled:false`
// (UNCAUGHT — never reached a React error boundary), so it leaks to Better
// Stack.
//
// Better Stack pattern
// aa1efd3fb7a9f6840d4eb25b881d2b12ac2e6f3c8dfe3158fbd3e9fc753a0526
// (Kortix Frontend prod, application_id 2346967): `SyntaxError`, message
// `Unexpected end of JSON input`, 1 occurrence / 0 identified users, last
// 2026-08-11 23:03:30 UTC, release
// `cd9dfccec1fb7e41a6726e9e45fd678cf428cc3a` (v0.12.8 prod), request URL
// `https://kortix.com/auth` (auth page — the consent banner loads there
// before the user is signed in), browser Safari on iOS 13.2.3 (iPhone — a
// very old iOS whose XHR/JSON paths are quirkier), mechanism
// `auto.browser.browserapierrors.xhr.onload` (UNCAUGHT, `handled:false`).
// Stack frames (3, all `in_app:true`):
//   1. `app:///_next/static/immutable/chunks/1zqaq83quwhm5.js` fn
//      `XMLHttpRequest.r` (the Next.js webpack runtime chunk that
//      `XMLHttpRequest` was monkey-patched through — the SCHEDULING frame,
//      NOT the throw site).
//   2. `app:///scripttemplates/otSDKStub.js?did=undefined` fn `r.onload`
//      (THROW SITE — the OneTrust SDK's `onload` handler where the
//      `JSON.parse` runs; `did=undefined` is the SDK's own misconfiguration
//      marker).
//   3. `<anonymous>` fn `JSON.parse` (the actual `JSON.parse` call the
//      OneTrust SDK makes on the empty body).
// NO first-party `apps/web/src/…` frame — the throw is in the OneTrust SDK's
// own injected script, never in our code.
//
// The `Unexpected end of JSON input` message is the GENERIC V8/JSC wording
// for `JSON.parse('')` / `JSON.parse(<truncated>)` — a real first-party
// `JSON.parse(truncatedApiResponse)` regression in our own code would throw
// the SAME wording, so matching on the message alone would swallow real app
// JSON-parsing bugs. Require BOTH the exact message AND a frame whose
// filename is the OneTrust SDK's `otSDKStub.js` source (the `app:///scripttemplates/otSDKStub.js?did=…`
// synthetic injected-script origin — the `otSDKStub.js` token is OneTrust's
// canonical bootstrap filename, never a first-party source path), so a real
// first-party `JSON.parse` SyntaxError keeps reporting. A NEGATIVE guard
// preserves any event whose stack carries a resolved first-party
// `apps/web/src/…` frame (our own code called `JSON.parse` on a bad body
// while a OneTrust frame happened to be in the stack → actionable). Returns
// false when there is no `otSDKStub.js` frame (can't confirm the OneTrust
// origin — keep reporting rather than swallow a possible first-party
// `JSON.parse` bug). Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there would swallow a real first-party
// `JSON.parse` SyntaxError the negative guard exists to preserve; the
// frame-aware `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`)
// is the only safe gate.
const ONETRUST_SDK_FRAME_PATTERN = /otSDKStub\.js/;
const ONETRUST_JSON_PARSE_NOISE_MESSAGE = /^Unexpected end of JSON input$/;

function isOneTrustSdkFrame(filename: unknown): boolean {
  return ONETRUST_SDK_FRAME_PATTERN.test(normalizeString(filename));
}

/**
 * Whether a Sentry / window.onerror event is the OneTrust cookie-consent SDK
 * JSON-parse noise class: OneTrust's `otSDKStub.js?did=<domainId>` bootstrap
 * stub XHR-fetches the site's consent config, and when the domain ID is
 * `undefined` / the endpoint returns an empty or truncated body (old iOS
 * Safari, CORS preflight failure, 5xx, network abort), the stub's
 * `XMLHttpRequest.onload` handler calls `JSON.parse()` on the bad body and
 * throws the canonical `SyntaxError: Unexpected end of JSON input`. The
 * throw is in the OneTrust SDK's own injected `otSDKStub.js` script, never
 * first-party code (`did=undefined` is the SDK's own misconfiguration
 * signal). Requires BOTH the EXACT `Unexpected end of JSON input` message
 * AND a frame whose filename contains `otSDKStub.js` (the OneTrust SDK's
 * canonical bootstrap filename — the `app:///scripttemplates/otSDKStub.js?did=…`
 * synthetic injected-script origin), with a NEGATIVE guard: if any frame
 * resolves to a de-minified first-party `apps/web/src/…` source path, the
 * event keeps reporting (a real first-party `JSON.parse(truncatedApiResponse)`
 * regression de-minifies to `apps/web/src/…` and must not be hidden).
 * Returns false when there is no `otSDKStub.js` frame (can't confirm the
 * OneTrust origin — keep reporting rather than swallow a possible first-
 * party `JSON.parse` bug). See `ONETRUST_JSON_PARSE_NOISE_MESSAGE` for the
 * full rationale and Better Stack pattern `aa1efd3fb…`.
 */
export function isOneTrustJsonParseNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!ONETRUST_JSON_PARSE_NOISE_MESSAGE.test(stripped)) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our
  // own code called `JSON.parse` on a bad body while a OneTrust frame
  // happened to be in the stack → actionable regression; keep reporting so
  // the call site can be found + fixed. (Mirrors `isInpageJsNoErrorMessageNoise`
  // / `isConnectionClosedNoise`'s negative guards.)
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  // Positive anchor: at least one frame (or the window.onerror `filename`)
  // is the OneTrust SDK's `otSDKStub.js` source. Without an `otSDKStub.js`
  // frame we cannot confirm the OneTrust origin — keep reporting rather
  // than swallow a possible first-party `JSON.parse` bug.
  return sources.some(isOneTrustSdkFrame);
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

/**
 * Whether a Sentry / window.onerror event is the wallet-extension injected-
 * `inpage.js` "No error message" noise class: a wallet extension's
 * `onGlobalMessage` → `runIfPresent` → `run` handlers in `app:///inpage.js`
 * throw a value that has no `.message` property, so Sentry SDK 10.x writes the
 * `"No error message"` placeholder. The error propagates through the React
 * reconciler and into the `global-error` boundary, which Sentry's `onerror`
 * handler then captures. This is a SIBLING of the stream EventEmitter noise
 * class (`isInpageWalletStreamNoise`), but a DIFFERENT throw — the message
 * is the placeholder string `"No error message"`, NOT an `addListener`/`emit`
 * TypeError. The stream-noise matcher does NOT catch it (message markers absent),
 * and `isEmptyMessageUnresolvedBrowserChunkNoise` does NOT catch it because the
 * `app:///inpage.js` frames are not browser-bundle sources.
 *
 * Requires BOTH the `"No error message"` placeholder (exact match:
 * `/^No error message$/`) AND a frame from `app:///inpage.js` (the wallet-
 * extension injected source), with a NEGATIVE guard: if any frame resolves to a
 * de-minified first-party `apps/web/src/…` source path, the event keeps reporting
 * (a real first-party error with no message that happens to have an inpage.js
 * frame in the stack is still actionable). Returns false when there is no
 * `app:///inpage.js` frame (can't confirm extension origin — keep reporting
 * rather than swallow a possible app bug). See the `shouldIgnoreSentryBrowserNoise`
 * call site for the full rationale and the production pattern `61949432…`.
 */
export function isInpageJsNoErrorMessageNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const message = normalizeString(input.message);
  if (message !== 'No error message') {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our own
  // code threw an error with no message — actionable, keep reporting so the call
  // site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  // Positive anchor: at least one frame is from `app:///inpage.js` (the wallet-
  // extension injected source). Without an inpage.js frame we cannot confirm the
  // extension origin — keep reporting rather than swallow a possible app bug.
  return sources.some(
    (filename) => isInpageWalletInjectedSource(filename) || isExtensionSource(filename),
  );
}

/**
 * Whether a Sentry / window.onerror event is the browser-extension
 * injectedScript.bundle.js `sendMessage` noise class: a browser extension
 * (commonly a wallet, adblocker, or privacy extension) injects a content script
 * as `app:///injectedScript.bundle.js` that calls `chrome.runtime.sendMessage`
 * / `browser.runtime.sendMessage` on a `runtime` object that is `undefined` in
 * a non-extension context or after the tab's extension context is torn down.
 * The throw is in the extension's own injected script, NEVER in first-party
 * Kortix code. The `app:///injectedScript.bundle.js` source is a synthetic
 * extension-injection frame (NOT an `app:///_next/…` bundle frame and NOT a
 * de-minified `apps/web/src/…` source path), so it is never a first-party call
 * site.
 *
 * Better Stack pattern
 * `95a70e668e9fbeb0c139131ac78db4aff62d5ab3675ed376666f9526c2cbb02c`
 * (Kortix Frontend prod, application_id 2346967): `Error`, message
 * `Cannot read properties of undefined (reading 'sendMessage')`, 1 occurrence /
 * 0 identified users, last 2026-07-30 14:07:17 UTC, stack frames:
 *   - `app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_…`
 *     function `u` (webpack runtime)
 *   - `app:///injectedScript.bundle.js` function `n` colno 84147
 *     (THROW SITE — the extension's injected script)
 * request URL `https://kortix.com/auth?redirect=%2Fprojects%2F…`,
 * mechanism `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT),
 * Chrome 150 / Windows.
 *
 * The `sendMessage` wording is a GENERIC browser-extension API call — a
 * first-party `chrome.runtime.sendMessage` / `browser.runtime.sendMessage`
 * call in app code would throw the SAME wording, so matching on message alone
 * would swallow real app extension-API bugs. Requires BOTH the `sendMessage`
 * message anchor AND an `app:///injectedScript.bundle.js` injected-source
 * frame (or any `INJECTED_APP_SOURCE_PATTERNS` source) so a real first-party
 * `sendMessage` call keeps reporting. A negative guard preserves any event
 * whose stack carries a resolved first-party `apps/web/src/…` frame (our own
 * code called `sendMessage` → actionable). Returns false when there is no
 * source anchor (can't confirm extension origin — keep reporting rather than
 * swallow a possible app `sendMessage` bug). See PR #5914.
 */
export function isInjectedScriptSendMessageNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!stripped.includes('sendMessage')) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our
  // own code is the `sendMessage` caller → actionable; keep reporting so the
  // call site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return sources.some(isInjectedAppSource);
}

// CAPTCHA / anti-bot browser-extension interceptor noise. A bot-detection
// service extension (DataDome, Cloudflare, or similar) injects a content
// script into every page as the synthetic source
// `app:///content/captcha/mt_captcha/interceptor.js` (the same `app:///`
// empty-host origin shape as the other injected/extension sources). The
// interceptor's own internal code races on widget initialization: a minified
// function (`d`) reaches for a widget configuration object that has not been
// initialized yet (it is still `undefined`) and reads its `widgetId` property
// → `TypeError: Cannot read properties of undefined (reading 'widgetId')`.
// The throw is in the extension's OWN injected interceptor, NEVER in
// first-party Kortix code: `app:///content/captcha/mt_captcha/interceptor.js`
// is a synthetic extension-injection source (NOT an `app:///_next/…` bundle
// frame and NOT a de-minified `apps/web/src/…` source path), `widgetId` is the
// extension's internal widget-configuration property (NOT a Kortix API), and
// the call-site function `d` is a minified extension function (NOT a
// de-minified `apps/web/src/…` frame).
//
// Better Stack patterns (Kortix Frontend prod, application_id 2346967) — TWO
// sibling fingerprints from the SAME extension interceptor, SAME type
// (`TypeError`), SAME message
// (`Cannot read properties of undefined (reading 'widgetId')`), SAME call-site
// function (`d`), SAME call-site file
// (`app:///content/captcha/mt_captcha/interceptor.js`):
//   - `cfd5f828fe374568ec3fb9163e035c73690fc8d768e75751df44badaea3a0283`
//     first 2026-08-08 17:03:49 UTC
//   - `4a01a1690345a3763a2865e134a42635215f76b8a71939275f1bf81b4edc3ef3`
//     first 2026-08-08 16:44:10 UTC
// Both are extension-injected content-script race noise, not first-party
// defects.
//
// `widgetId` is the extension's INTERNAL widget-configuration property name
// — it is specific enough to anchor on (it is never a Kortix API surface; our
// code never reads a `widgetId` property), but it is a property NAME (not a
// canonical library string like `Paper Shaders: …`), so — mirroring
// `isInjectedScriptSendMessageNoise` (the `sendMessage` wallet-extension
// matcher) — this matcher requires BOTH the `widgetId` message anchor AND a
// frame from the injected `app:///content/captcha/mt_captcha/interceptor.js`
// source (via `isInjectedAppSource`, after adding the pattern there), so a
// real first-party `something.widgetId` null/undefined deref keeps reporting.
// A NEGATIVE guard preserves any event whose stack carries a resolved
// first-party `apps/web/src/…` frame (our own code deref'd a `widgetId`
// property → actionable). Returns false when there is no source anchor
// (can't confirm extension origin — keep reporting rather than swallow a
// possible app `widgetId` bug). Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there would swallow a real first-party
// `widgetId` deref the negative guard exists to preserve; the frame-aware
// `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`) is the
// only safe gate.
/**
 * Whether a Sentry / window.onerror event is the CAPTCHA / anti-bot
 * browser-extension interceptor noise class: the extension's injected
 * `app:///content/captcha/mt_captcha/interceptor.js` content script races on
 * widget initialization and a minified function reads `widgetId` on a widget
 * configuration object that is still `undefined` →
 * `TypeError: Cannot read properties of undefined (reading 'widgetId')`. The
 * throw is in the extension's OWN injected interceptor, never first-party
 * code. Requires BOTH the `widgetId` message anchor AND a frame from the
 * injected `app:///content/captcha/mt_captcha/interceptor.js` source (via
 * `isInjectedAppSource`), so a real first-party `widgetId` deref keeps
 * reporting. A negative guard preserves any event whose stack carries a
 * resolved first-party `apps/web/src/…` frame (our own code deref'd a
 * `widgetId` property → actionable). Returns false when there is no source
 * anchor (can't confirm extension origin — keep reporting). See the
 * `isCaptchaInterceptorNoise` comment block above for the full rationale and
 * the two Better Stack production patterns.
 */
export function isCaptchaInterceptorNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!stripped.includes('widgetId')) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our
  // own code deref'd a `widgetId` property on an `undefined` value →
  // actionable; keep reporting so the call site can be found + fixed. (Mirrors
  // `isInjectedScriptSendMessageNoise`'s negative guard.)
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  // Positive anchor: at least one frame (or the window.onerror `filename`) is
  // an injected-app source — the CAPTCHA interceptor's
  // `app:///content/captcha/mt_captcha/interceptor.js` or any other
  // `INJECTED_APP_SOURCE_PATTERNS` source. Without an injected-source anchor
  // we cannot confirm the extension origin — keep reporting rather than
  // swallow a possible first-party `widgetId` bug.
  return sources.some(isInjectedAppSource);
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
    (expected) => normalized === expected
      || normalized === `Error: ${expected}`
      || normalized === `Unhandled promise rejection: ${expected}`
      || normalized === `Unhandled promise rejection: Error: ${expected}`,
  );
}

/**
 * Whether a message is the EXPECTED "model not available for this account"
 * UI validation state — the typed 409 `code: 'model_not_servable'` the API
 * returns (`apps/api/src/projects/routes/r4.ts` + `channel-bindings.ts` via
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
 * Matches all six wordings of this class: five JS-engine / DOM-binding variants
 * — V8 (`Cannot read properties of null (reading '<m>')`), old JSC
 * (`Cannot read property '<m>' of null`), SpiderMonkey/Firefox
 * (`can't access property "<m>"<…>`), modern JSC (Safari / Chrome-on-iOS
 * CriOS, which uses WebKit/JSC rather than V8:
 * `null is not an object (evaluating 'this.gl.<m>')`), and Gecko/Firefox
 * DOM-binding (`WebGL2RenderingContext.<m>: Argument 1 is not an object.` —
 * Firefox's DOM bindings throw on the method call itself when the `this`
 * binding is the null WebGL2 context) — PLUS the library's OWN internal guard
 * wording (`this.gl is null` — the library's own explicit throw when its state
 * check detects the null context, distinct from any JS-engine TypeError).
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

/**
 * Whether a Sentry event is the Paper Shaders
 * (`@paper-design/shaders-react`) WebGL-unsupported deliberate-throw noise
 * class: the library's OWN canonical
 * `Paper Shaders: WebGL is not supported in this browser` `Error`, thrown from
 * the library's shader-mount constructor when WebGL is unavailable (a
 * stripped-down/mobile WebView, a headless renderer, a browser with WebGL
 * disabled, or a GPU blacklisted at context creation). This is a SIBLING of
 * the null-context crash class (`isPaperShaderNullContextNoise`), but a
 * DIFFERENT throw — a deliberate library `Error`, NOT a null-context
 * `TypeError` from calling a WebGL2 method on a `null` context. The throw
 * escapes `<ShaderSafe>` (it fires from the library constructor inside a
 * dynamic import / `useEffect` that bypasses the React error boundary) and
 * reaches Sentry as an uncaught global `onunhandledrejection` — an EXPECTED
 * degradation state on WebGL-less browsers, never a product bug. The
 * `supportsWebGL2()` probe in `shader-safe.tsx` is the primary guard that
 * degrades to the fallback BEFORE the throw; this matcher is the leak-path
 * backstop for the residual async throw that bypasses the one-shot probe.
 *
 * Requires the EXACT library message (case-sensitive; the `Paper Shaders:`
 * prefix is the library's canonical marker, never emitted by first-party
 * app code) AND a NEGATIVE guard: if ANY frame resolves to a de-minified
 * first-party `apps/web/src/…` source path, the event keeps reporting (a
 * real first-party `throw new Error('Paper Shaders: WebGL is not supported
 * in this browser')` regression de-minifies to `apps/web/src/…` and must not
 * be hidden). The production noise pattern carries only minified
 * `@paper-design/shaders` chunk frames, so the negative guard does not fire
 * for it. A frameless capture with this exact message still classifies as
 * noise (the message alone is specific — the `Paper Shaders:` library prefix
 * is part of the anchor, so a near-worded `WebGL is not supported in this
 * browser` without the prefix does NOT match). See
 * `PAPER_SHADER_WEBGL_UNSUPPORTED_NOISE_MESSAGE` for the full rationale.
 */
export function isPaperShaderWebGLUnsupportedNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  // `stripErrorWrappers` strips `Unhandled promise rejection: ` and typed
  // `<Name>Error: ` prefixes (e.g. `TypeError: `), but NOT a bare `Error: `
  // (its `[A-Za-z]+Error:` requires a leading prefix). Sentry capture paths
  // can deliver either shape, so additionally strip a leading bare `Error: `
  // here — mirroring `isBareImageLoadNoiseMessage`'s explicit `Error: ` form.
  const stripped = stripErrorWrappers(normalizeString(input.message)).replace(
    /^Error: /,
    '',
  );
  if (stripped !== PAPER_SHADER_WEBGL_UNSUPPORTED_NOISE_MESSAGE) {
    return false;
  }
  const frames = input.frames ?? [];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our
  // own code threw this exact message → a real first-party regression (even
  // though the `Paper Shaders:` prefix is the library's canonical marker, a
  // hostile/copy-pasted first-party throw could share it). Keep reporting so
  // the call site can be found + fixed. Only the library throw (minified
  // `@paper-design/shaders` chunk frames, or frameless) is dropped. No second
  // "any resolvable frame" guard is needed — the message is specific enough
  // (the library's canonical string) that a frameless capture is safe to
  // drop, unlike the generic `undefined` / `OperationError` matchers.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  return true;
}

/**
 * Whether a Sentry / window.onerror event is the Canvas `getImageData`
 * out-of-memory noise class: a `RangeError` from
 * `CanvasRenderingContext2D.getImageData()` running out of memory allocating
 * the `ImageData` buffer — the browser's canonical
 * `Failed to execute 'getImageData' on 'CanvasRenderingContext2D': Out of
 * memory at ImageData creation` message. This is TRANSIENT browser resource
 * exhaustion (the canvas was too large / the tab was under memory pressure /
 * the device is low-RAM), fired from a third-party canvas library's
 * `addEventListener` callback (Sentry's `BrowserApiErrors` auto-wrapper captures
 * it as UNCAUGHT, `handled:false` — never reached a React error boundary).
 * NOT a deterministic code bug — the same canvas renders fine on the next
 * visit once memory frees up. See `CANVAS_GETIMAGE_DATA_OOM_NOISE_PATTERNS`
 * for the full rationale and Better Stack pattern `b4b43847…`.
 *
 * Requires the EXACT V8/Chrome message AND a NEGATIVE guard: if any frame (or
 * the window.onerror `filename`) resolves to a de-minified first-party
 * `apps/web/src/…` source path, the event keeps reporting — our own code is
 * the `getImageData` caller and a real first-party OOM regression is
 * actionable. Only events with NO resolved first-party frame (the prod noise
 * shape: all minified third-party canvas library chunk frames, or frameless)
 * are dropped. A frameless capture with this exact message still classifies
 * as noise (the message alone is the browser's canonical OOM wording and is
 * specific enough — the `CanvasRenderingContext2D` + `getImageData` +
 * `ImageData creation` tokens together pin this single DOM API call site).
 * `RangeError: ` / `Unhandled promise rejection: ` wrappers are stripped
 * before matching so all capture paths (window.onerror, onunhandledrejection,
 * Sentry exception) classify consistently.
 */
export function isCanvasImageDataOOMNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!CANVAS_GETIMAGE_DATA_OOM_NOISE_PATTERNS.some((re) => re.test(stripped))) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame (or
  // window.onerror `filename`) means our own code is the `getImageData` caller
  // → a real first-party OOM regression; keep reporting so the call site can
  // be found + fixed. A real first-party `getImageData` OOM de-minifies to
  // `apps/web/src/…` and is never hidden.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
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
 * Whether a Sentry / window.onerror event is the old-browser third-party-
 * library DOM null-deref noise class: a `TypeError: Cannot read properties of
 * null (reading 'scrollLeft')` / `… (reading 'appendChild')` (V8 wording; old
 * JSC says `Cannot read property '<X>' of null`) thrown from minified
 * THIRD-PARTY library internals (`measureScroll` in a scroll-measurement
 * library, `ft` in an animation/DOM-manipulation helper) running on VERY OLD
 * browsers (Windows 7 Chrome, Chrome 95 Linux) hitting the marketing
 * homepage. The browser's quirkier DOM behavior returns `null` where modern
 * browsers return an element, and the library accesses `.scrollLeft` /
 * `.appendChild` on the `null` → `TypeError`. UNCAUGHT global `onerror`
 * (`handled:false` — never reaches a React error boundary), 2 occurrences
 * each, 0 identified users, marketing page only — browser-compatibility
 * noise, not a product defect.
 *
 * `scrollLeft` and `appendChild` are STANDARD DOM API method names that
 * first-party React code DOES call (e.g. `use-proximity-hover.ts` reads
 * `container.scrollLeft`, `session-title.tsx` sets `el.scrollLeft`, portal/
 * tooltip ref-callbacks call `appendChild`), so the matcher requires BOTH the
 * exact V8/old-JSC message AND a NEGATIVE guard: if ANY frame (or the
 * window.onerror `filename`) resolves to a de-minified first-party
 * `apps/web/src/…` source path, the event KEEPS reporting — our own code is
 * the null-deref culprit and is actionable to fix. The production noise
 * events carry only minified `app:///_next/static/chunks/…` chunk frames
 * (the third-party library internals) + an `<anonymous>` frame, so the
 * negative guard does NOT fire for them. A frameless capture with one of
 * these exact messages still classifies as noise — `measureScroll` and the
 * minified `ft` are third-party library internals, and a real first-party
 * `el.scrollLeft` / `parent.appendChild` null-deref almost always has a
 * resolvable frame with a stack. See
 * `OLD_BROWSER_DOM_NULL_DEREF_NOISE_PATTERNS` for the full rationale and the
 * two production Better Stack patterns.
 */
export function isOldBrowserDomNullDerefNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const message = normalizeString(input.message);
  if (!message) return false;
  const stripped = stripErrorWrappers(message);
  if (!OLD_BROWSER_DOM_NULL_DEREF_NOISE_PATTERNS.some((re) => re.test(stripped))) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame (or
  // window.onerror `filename`) means our own code is the null-deref culprit →
  // actionable; keep reporting so the call site can be found + fixed. A real
  // first-party `el.scrollLeft` / `parent.appendChild` null-deref de-minifies to
  // `apps/web/src/…` and is never hidden.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
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

/**
 * Whether an event is the Android System WebView native-bridge
 * `Error invoking postEvent: Java object is gone` noise class: the WebView's
 * injected `JavaBridge` calls `postEvent` on a native Java bridge whose
 * backing `JavaObject` has been garbage-collected (page navigation / WebView
 * teardown / in-app browser dismiss). This is the WebView's OWN bridge
 * plumbing, not first-party code. The `postEvent` variant surfaces in TWO
 * capture shapes, both anchored on the exact message:
 *   1. FRAMELESS (PR #5181, BS `a6795db2…`): `<anonymous>` / `?` call site,
 *      no resolvable stack, captured by Sentry's global `onerror`/
 *      `onunhandledrejection`.
 *   2. `setTimeout`-wrapped (BS `f50ed590…`): Sentry's `BrowserApiErrors`
 *      integration auto-wraps `setTimeout` and records the SCHEDULING frame
 *      (an `app:///_next/…` webpack runtime chunk where the timer was
 *      registered) as frame #1, plus the actual THROW SITE (`<anonymous>`,
 *      the anonymous timer callback = the WebView bridge hop) as frame #2.
 *      The scheduling frame is incidental — it is where `setTimeout` was
 *      called, NOT where the throw originates.
 * Both shapes carry the `<anonymous>` throw-site frame (the Android WebView
 * bridge hop, never a first-party call site). `Java object is gone` is the
 * canonical Android System WebView Java-bridge-GC'd message; it is never
 * raised by first-party app code or by desktop Chrome, so the `<anonymous>`
 * throw-site frame is a specific positive anchor. The matcher suppresses
 * when: the frame is the synthetic `app://navigation_performance_logger_
 * android` bridge source (the #4610 sibling shape), OR the throw site is the
 * canonical `<anonymous>` bridge frame, OR the capture is frameless (no
 * resolvable source at all). A genuine first-party `postEvent` /
 * `dispatchEvent` failure throws from a NAMED function in an `app:///_next/…`
 * chunk or a de-minified `apps/web/src/…` frame (never the bare `<anonymous>`
 * throw-site shape) and is preserved by the first-party negative guard. An
 * INCIDENTAL webpack-runtime scheduling frame (`app:///_next/static/chunks/
 * webpack-…` or any non-first-party `app:///_next/…` chunk) does NOT veto
 * suppression — it is where the timer was registered, not where the throw
 * originated. Never page Better Stack for this class. See
 * `ANDROID_WEBVIEW_NATIVE_BRIDGE_POSTEVENT_NOISE_MESSAGES` for the full
 * rationale.
 */
export function isAndroidWebViewNativeBridgePostEventNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (
    !ANDROID_WEBVIEW_NATIVE_BRIDGE_POSTEVENT_NOISE_MESSAGES.some(
      (noise) => message === noise,
    )
  ) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Positive anchor #1: the synthetic Android nav-performance-logger bridge
  // source (the framed sibling shape, forward-compat with #4610's evidence).
  if (sources.some((filename) => isAndroidNavPerfLoggerFrame(filename))) {
    return true;
  }
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame → our
  // own event-dispatch code is failing; keep reporting so the call site can
  // be found + fixed. A real first-party `postEvent`/`dispatchEvent`
  // regression de-minifies to `apps/web/src/…` and is never hidden.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  // Positive anchor #2: the canonical Android WebView `JavaBridge` throw-site
  // frame `<anonymous>` (function `?`). The `BrowserApiErrors.setTimeout` /
  // `addEventListener` auto-wrapper records the SCHEDULING frame (an
  // `app:///_next/…` webpack chunk where the timer was REGISTERED) as the
  // first frame, but the actual throw originates at the `<anonymous>`
  // callback — the WebView bridge hop, never a first-party call site. `Java
  // object is gone` is uniquely an Android WebView internal message, so the
  // `<anonymous>` throw-site frame is a specific positive anchor for this
  // exact message. (BS `f50ed590…`.)
  if (sources.some((filename) => normalizeString(filename) === ANDROID_WEBVIEW_BRIDGE_THROW_SITE_FRAME)) {
    return true;
  }
  // Negative guard #2: any OTHER resolvable source location (real app chunk
  // with a NAMED function, URL, or named file — NOT the `<anonymous>` throw
  // site already matched above, NOT a first-party `apps/web/src/…` path
  // already matched by guard #1) → an actionable event-dispatch error with a
  // real, attributable stack; keep reporting. Only the frameless capture
  // (the #5181 shape) remains → Android WebView native-bridge GC noise.
  if (sources.some(isResolvableFrameSource)) {
    return false;
  }
  return true;
}

/**
 * Whether a Sentry / window.onerror event is the iOS WebKit (WKWebView) in-app-
 * browser native-bridge instrumentation noise class: the iOS WebView's
 * injected `app:///` script records navigation/performance timing
 * (`processLargestContentfulPaintEvent`) and ships it to its native bridge via
 * `sendDataToNative` → `window.webkit.messageHandlers`. On iOS WebViews where
 * the WebKit `messageHandlers` bridge is unavailable (host app didn't wire it,
 * or page load/teardown), `window.webkit` is `undefined` and the property
 * access throws JSC's canonical
 * `undefined is not an object (evaluating 'window.webkit.messageHandlers')`.
 * This is the iOS sibling of the Android WebView bridge noise
 * (`isAndroidWebViewNativeBridgePost{Message,Event}Noise`, PRs #5181/#4610);
 * the Android matchers anchor on the synthetic
 * `app://navigation_performance_logger_android` source and the
 * `postMessage`/`postEvent` Java-bridge-GC message, so they do NOT catch the
 * iOS `app:///` + `window.webkit.messageHandlers` variant. This is the
 * WebView's OWN instrumentation, never first-party code. Requires BOTH the
 * EXACT `messageHandlers` message AND a POSITIVE frame anchor: at least one
 * frame whose filename is the synthetic `app:///` source OR whose function is
 * an iOS WebView instrumentation internal (`sendDataToNative` /
 * `processLargestContentfulPaintEvent`). A NEGATIVE guard preserves any
 * resolved first-party `apps/web/src/…` frame so a real first-party
 * `window.webkit.messageHandlers` access regression keeps reporting. Never page
 * Better Stack for this class. See `IOS_WEBVIEW_WEBKIT_BRIDGE_NOISE_MESSAGE`
 * for the full rationale.
 */
export function isIOSWebViewWebKitBridgeNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (stripped !== IOS_WEBVIEW_WEBKIT_BRIDGE_NOISE_MESSAGE) {
    return false;
  }
  // Collect every source location — the window.onerror `filename` (runtime
  // gate) and any stacktrace frames (Sentry gate) — for the anchors.
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our own
  // code accessed `window.webkit.messageHandlers` and threw → a real first-
  // party regression; keep reporting so the call site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  // Positive anchor: at least one frame is the synthetic `app:///` iOS WebView
  // injected-instrumentation source, OR whose function is one of the iOS
  // WebView instrumentation internals (`sendDataToNative` /
  // `processLargestContentfulPaintEvent`). The function-name anchor is stable
  // across deploys (mirrors #5181's `postEvent` anchor). Prefer the
  // function-name check first (it is the prod call_site anchor).
  const frames = input.frames ?? [];
  const hasInstrumentedFunction = frames.some((frame) =>
    IOS_WEBVIEW_INSTRUMENTED_FUNCTION_NAMES.has(normalizeString(frame?.function)),
  );
  const hasInstrumentedSource = sources.some((filename) =>
    normalizeString(filename) === IOS_WEBVIEW_INSTRUMENTED_FRAME_SOURCE,
  );
  // Without the positive anchor (no `app:///` frame and no instrumentation
  // function) we cannot confirm the iOS WebView origin — keep reporting rather
  // than swallow a possible first-party `window.webkit.messageHandlers`
  // access. The prod event carries 3 `app:///` frames including the throwing
  // `sendDataToNative`, so the anchor matches.
  return hasInstrumentedFunction || hasInstrumentedSource;
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

// The EXACT V8 wording of the @embedpdf/plugin-tiling `TilingLayer` viewport-
// advance tile-destructure throw: under a rapid scroll/zoom burst the tiling
// plugin's tile queue drains mid-burst, the viewport-advance path calls
// `const { tile } = queue.pop()` on an `undefined` pop result, and V8 reports
// `Cannot destructure property 'tile' of 'r.pop(...)' as it is undefined.` (the
// minified queue is `r`, so the destructure target renders as `r.pop(...)`).
// The `tile` property name + the `r.pop(...)` destructure target together pin
// this single call site; a different destructure (different property / different
// expression) is a different throw and must keep reporting. Anchored as an EXACT
// string match (after `stripErrorWrappers`) like the Paper Shaders patterns —
// not a loose prefix — so a near-worded regression cannot slip through.
const EMBEDPDF_TILING_TILE_DESTRUCTURE_NOISE_MESSAGE =
  "Cannot destructure property 'tile' of 'r.pop(...)' as it is undefined.";

// The @embedpdf/plugin-tiling `TilingLayer` viewport-advance internal frame
// anchors. Under a scroll/zoom burst the tiling plugin's viewport advance path
// (`t5.advance` → `iA.ignore` → `iA.onScroll` / `iA.onScrollChanged`, plus the
// `IntersectionObserver` threshold callback that drives viewport recomputation)
// pops the drained tile queue. These minified function names are the tiling
// plugin's own viewport-advance internals (never present in first-party
// `apps/web/src/…` source), so their presence is a specific third-party anchor.
// Function names are stable across deploys (unlike the `c63a46fc` chunk hash,
// which changes every release), so they are the primary anchor; the chunk hash
// is a fallback for captures whose function names were stripped.
const EMBEDPDF_TILING_VIEWPORT_ADVANCE_FRAME_MARKERS = [
  't5.advance',
  'iA.ignore',
  'iA.onScroll',
  'iA.onScrollChanged',
  'IntersectionObserver.intersection.IntersectionObserver.threshold',
] as const;

// The minified @embedpdf/plugin-tiling tiling chunk hash seen in both prod
// patterns (`c63a46fc-270e35c76d7636cb.js`). Changes per deploy, so it is a
// fallback anchor only — the function-name markers above are preferred.
const EMBEDPDF_TILING_CHUNK_MARKER = 'c63a46fc';

function frameMatchesEmbedPdfTilingViewportAdvance(
  frame: { filename?: unknown; function?: unknown } | undefined,
): boolean {
  const fn = normalizeString(frame?.function);
  if (
    EMBEDPDF_TILING_VIEWPORT_ADVANCE_FRAME_MARKERS.some((marker) =>
      fn.includes(marker),
    )
  ) {
    return true;
  }
  return normalizeString(frame?.filename).includes(EMBEDPDF_TILING_CHUNK_MARKER);
}

/**
 * Whether a Sentry exception is the `@embedpdf/plugin-tiling` `TilingLayer`
 * viewport-advance tile-destructure noise class: under a rapid scroll/zoom
 * burst the tiling plugin's tile queue drains mid-burst, the viewport-advance
 * path (`t5.advance` / `iA.ignore` / `iA.onScroll` / `iA.onScrollChanged` /
 * `IntersectionObserver.threshold`) calls `const { tile } = queue.pop()` on an
 * `undefined` pop result, and V8 throws
 * `Cannot destructure property 'tile' of 'r.pop(...)' as it is undefined.` The
 * throw is in third-party bundled code (the minified `c63a46fc` tiling chunk),
 * never first-party. This is a SIBLING of the React #185 render-loop class
 * (`isEmbedPdfTilingReactUpdateDepthNoise`, Better Stack pattern `366115d4…`,
 * PR #4718) but a DIFFERENT throw from a different embedpdf tiling path (the
 * viewport-advance path, not the `onTileRendering` subscription callback), so the
 * #4718 matcher — anchored on the `Minified React error #185` message + the
 * `onTileRendering` frame — does NOT catch it. Requires BOTH the EXACT message
 * AND a positive viewport-advance frame anchor (function name or the
 * `c63a46fc` tiling chunk), AND a NEGATIVE guard: if any frame resolves to a
 * de-minified first-party `apps/web/src/…` source, the event keeps reporting (a
 * real first-party `{ tile } = arr.pop()` regression de-minifies to
 * `apps/web/src/…` and must not be hidden). The `tile` property name is part of
 * the anchor, so a different destructure (`{ foo } = r.pop()`) keeps reporting.
 * Returns false when there are no frames (can't confirm the tiling anchor — keep
 * reporting). See Better Stack patterns `3e579401…` / `70272e1e…`.
 */
export function isEmbedPdfTilingTileDestructureNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown } | undefined>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (message !== EMBEDPDF_TILING_TILE_DESTRUCTURE_NOISE_MESSAGE) {
    return false;
  }
  const frames = input.frames ?? [];
  if (frames.length === 0) {
    return false;
  }
  // Negative guard: a resolved first-party frame means our own code is the
  // destructure culprit → actionable; keep reporting so the call site can be
  // found. A real first-party `{ tile } = arr.pop()` regression de-minifies to
  // `apps/web/src/…` and must never be hidden.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Anchor: the throw must be inside @embedpdf/plugin-tiling's viewport-advance
  // path. These frames are never present in first-party code, so a real
  // first-party tile-destructure (or a same-worded throw from a different
  // third-party lib) is never matched.
  return frames.some(frameMatchesEmbedPdfTilingViewportAdvance);
}

// Broader third-party-library React #185 "Maximum update depth exceeded"
// fallback noise matcher. The `isEmbedPdfTilingReactUpdateDepthNoise`
// matcher above anchors on the SPECIFIC `@embedpdf/plugin-tiling`
// `onTileRendering` subscription callback frame; it does NOT catch #185
// events thrown by OTHER third-party libs (no `onTileRendering` frame). The
// editor re-render loop siblings fired by the document-state race (see
// `isDocumentStateNotFoundNoise`) are such a class: a ProseMirror/TipTap-
// based editor library's async interaction/selection handler re-enters the
// React render loop after the editor's document-state map race, tripping
// React's 50-nested-update guard (#185) WITHOUT an `onTileRendering` frame.
//
// Better Stack patterns (Kortix Frontend prod, application_id 2346967) — all
// three from the SAME Safari 26.5 session
// `be897489-001b-4ca4-b9ca-a1aa770c4082`, SAME release
// `f2db5007f14e77e3b9456d2f83208e97bc2b2734`, SAME chunk
// `0foj1ouh5ijrj.js`, same 2026-08-05 ~04:30–05:28 UTC window as the doc-state
// race siblings, 1 occurrence each / 0 identified users, all UNCAUGHT
// (`handled:false`, never reached a React error boundary):
//   - `223d7d7e1000bc98be5969f2cddac143e03134cb39442f0b959cf1def53ccb8a`:
//     mechanism `auto.browser.global_handlers.onerror`, frames
//     `r @ 13jg6.ewllp.z.js | f_ @ 0foj1ouh5ijrj.js | fL | s4 | nM | ? | sZ |
//     ? @ 00ym4.y9k1959.js | ov @ 0foj1ouh5ijrj.js | oy @ 0foj1ouh5ijrj.js`.
//   - `51b14963e617b4cee9926db4a4d6a9d50d4bdfb3b71d5f32faf1c83d33066d12`:
//     mechanism `auto.browser.browserapierrors.setInterval`, frames
//     `r @ 13jg6.ewllp.z.js | ? @ 12r-_umoe~03c.js | ov @ 0foj1ouh5ijrj.js |
//     oy @ 0foj1ouh5ijrj.js`.
//   - `cd68e360db0f42e7dca4e9e922cfe80ed629e878dbb327f74ac889d194da0276`:
//     call_site_function `oy`, call_site_file
//     `app:///_next/static/chunks/0foj1ouh5ijrj.js`.
// ALL three carry NO `onTileRendering` frame and NO first-party
// `apps/web/src/…` frame — they are the editor library's own re-render loop,
// not a first-party setState loop.
//
// React #185 is ALSO the exact message a REAL first-party infinite-setState
// loop produces, so this BROADER fallback matcher is anchored on BOTH the
// #185 message (`REACT_UPDATE_DEPTH_NOISE_PATTERN`, already defined above)
// AND TWO negative guards:
//   1. NO resolved first-party `apps/web/src/…` frame — a real first-party
//      setState loop de-minifies to `apps/web/src/…` and is preserved (this
//      is the load-bearing guard; it mirrors the tiling matcher).
//   2. The event is UNCAUGHT — the exception's mechanism is one of the
//      global auto-handlers (`onerror` / `onunhandledrejection`) OR a
//      `BrowserApiErrors` auto-wrapper (`addEventListener` / `setTimeout` /
//      `setInterval`/ …) with `handled:false`. A CAUGHT React #185 (one that
//      reached a React error boundary, `handled:true`) may be actionable —
//      the boundary exists precisely to surface first-party render loops the
//      app chose to handle — so it keeps reporting. The production noise
//      siblings are all `handled:false` global/BrowserApiErrors captures.
//
// IMPORTANT: this is a FALLBACK that runs AFTER `isEmbedPdfTilingReactUpdateDepthNoise`
// (the tiling matcher is tried first in `shouldIgnoreSentryBrowserNoise`, so
// its more specific `onTileRendering` anchor wins for the tiling class). It
// does NOT replace or subsume the tiling matcher; a tiling #185 with an
// `onTileRendering` frame is dropped by the tiling matcher before this
// fallback is reached. This fallback only catches the non-tiling third-party
// #185 class (the editor re-render loop siblings here). Deliberately NOT
// added to `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no
// frame/mechanism context, so a bare `#185` match there would swallow a real
// first-party setState loop; the frame+mechanism-aware `beforeSend` hook
// (which calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
//
// The Sentry `BrowserApiErrors` integration auto-wraps these EventTarget /
// timer APIs and captures throws from inside their callbacks as
// `handled:false` (`auto.browser.browserapierrors.<api>`); the global
// `GlobalHandlers` integration captures `onerror`/`onunhandledrejection` as
// `auto.browser.global_handlers.<handler>` (`handled:false`). All of these
// are UNCAUGHT — they never reached a React error boundary. A CAUGHT #185
// (mechanism absent, or `handled:true`, or a non-global/non-BrowserApiErrors
// mechanism) keeps reporting.
const REACT_UPDATE_DEPTH_UNCAUGHT_MECHANISMS = new Set([
  'auto.browser.global_handlers.onerror',
  'auto.browser.global_handlers.onunhandledrejection',
  'auto.browser.browserapierrors.addEventListener',
  'auto.browser.browserapierrors.setTimeout',
  'auto.browser.browserapierrors.setInterval',
  'auto.browser.browserapierrors.requestAnimationFrame',
]);

/**
 * Whether a Sentry event is a third-party-library React #185 "Maximum update
 * depth exceeded" render loop that is NOT the `@embedpdf/plugin-tiling`
 * `onTileRendering` class (caught by `isEmbedPdfTilingReactUpdateDepthNoise`
 * above). This is the BROADER FALLBACK for non-tiling third-party #185s —
 * e.g. the ProseMirror/TipTap-based editor library's re-render loop fired by
 * its document-state race (see `isDocumentStateNotFoundNoise`). Requires
 * the `Minified React error #185` message AND TWO negative guards: (1) NO
 * resolved first-party `apps/web/src/…` frame (a real first-party setState
 * loop de-minifies to `apps/web/src/…` and is preserved), and (2) the event
 * is UNCAUGHT — its mechanism is one of the global auto-handlers
 * (`onerror`/`onunhandledrejection`) or a `BrowserApiErrors` auto-wrapper
 * (`addEventListener`/`setTimeout`/`setInterval`/…) with `handled:false`. A
 * CAUGHT React #185 (reached a React error boundary, `handled:true`) may be
 * actionable and keeps reporting. This matcher runs AFTER
 * `isEmbedPdfTilingReactUpdateDepthNoise` (the tiling matcher's more
 * specific `onTileRendering` anchor is tried first), so it does NOT replace
 * or subsume the tiling matcher. See
 * `REACT_UPDATE_DEPTH_UNCAUGHT_MECHANISMS` for the full rationale and the
 * three Better Stack patterns `223d7d7e…` / `51b14963…` / `cd68e360…`.
 */
export function isThirdPartyReactUpdateDepthNoise(input: {
  message?: unknown;
  mechanism?: unknown;
  handled?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown } | undefined>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (!REACT_UPDATE_DEPTH_NOISE_PATTERN.test(message)) {
    return false;
  }
  const frames = input.frames ?? [];
  // No frames at all → can't confirm the throw is third-party (no
  // `apps/web/src/…` negative-guard evidence, no chunk anchor). Keep
  // reporting rather than blanket-dropping frameless #185s of unknown
  // origin. (Mirrors `isEmbedPdfTilingReactUpdateDepthNoise`.)
  if (frames.length === 0) {
    return false;
  }
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame means
  // our own component is the looping culprit → actionable; keep reporting so
  // the call site can be found + fixed. (Mirrors the tiling matcher.)
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Negative guard #2: the event must be UNCAUGHT. A CAUGHT React #185 (one
  // that reached a React error boundary, `handled:true`, or whose mechanism
  // is not a global/BrowserApiErrors auto-handler) may be actionable — the
  // boundary exists to surface first-party render loops the app chose to
  // handle — so it keeps reporting. The production noise siblings are all
  // `handled:false` global/BrowserApiErrors captures.
  const mechanism = normalizeString(input.mechanism);
  if (!REACT_UPDATE_DEPTH_UNCAUGHT_MECHANISMS.has(mechanism)) {
    return false;
  }
  // `handled` is optional in the Sentry payload; when present it is a boolean.
  // Treat a missing `handled` as uncaught (the global/BrowserApiErrors
  // mechanisms above are UNCAUGHT by definition — they auto-capture throws
  // that never reached a React error boundary). When present and `true`, the
  // event was caught by a boundary → keep reporting.
  const handled = input.handled;
  if (handled === true) {
    return false;
  }
  return true;
}

// React #327 = `Should not already be working.` — the React production
// reconciler's re-entrancy guard. It throws from
// `packages/react-reconciler/src/ReactFiberWorkLoop.js`'s `performSyncWorkOnRoot`
// (and the `flushSyncUpdateQueue` path at the end of `flushPendingEffects`):
//
//   function performSyncWorkOnRoot(root, lanes) {
//     if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
//       throw new Error('Should not already be working.');   // ← #327
//     }
//     …
//   }
//
// i.e. React's scheduler entered `performSyncWorkOnRoot` while it was ALREADY
// rendering or committing. The documented Firefox-specific trigger is React
// Router's `unstable_usePrompt` calling `setTimeout(blocker.proceed, 0)` after
// `window.confirm()` (react-router#10314 — the React team itself called this a
// "browser-specific issue, possibly related to policy things built-in to
// Firefox"). The same #327 has been reported across the React ecosystem from
// Firefox's MessageChannel-based scheduler re-entering during the commit phase
// (react#17355, react#29908, react-router#10314, react-router#10547) — it does
// NOT reproduce on Chromium/WebKit, only on Firefox.
//
// Better Stack pattern
// 0f03b24eb662c20779ea6397c6501f40392a3c9e24ab0f4594ad367eda71b9b7
// (Kortix Frontend prod, application_id 2346967): 1 occurrence ever (90-day
// window), 0 identified users (anonymous), single release
// `22e12080d2b37642aa92a839da6b37f30fc21b9d`, 2026-07-20 11:53:33 UTC, route
// `/projects/:id/sessions/:sessionId` (co-worker session page actively polling
// `prompt_async` + UI clicks to remove queued messages — a state-heavy surface
// that maximises scheduler churn), Firefox 152.0 on Generic Linux, mechanism
// `auto.browser.global_handlers.onerror` (UNCAUGHT global error — never reached
// a React error boundary). Stack: 2 frames, BOTH raw React-internal minified
// production chunks:
//   - chunk 66499-30a0e6805d268c02.js  function `x`   (scheduler continuation)
//   - chunk 5ccd075d-fe5b6a678bf52bfe.js function `iX` (React DOM reconciler
//     `ensureRootIsScheduled`/`performConcurrentWorkOnRoot` continuation →
//     `iu` (`performSyncWorkOnRoot`) which throws `Error(i(327))` when
//     `executionContext & 6` is set)
// NO first-party `apps/web/src/…` source frame — the throw is inside React's
// own production reconciler, never in our code. There is exactly ONE `flushSync`
// call site in the entire frontend (`pdf-viewer.tsx:2101`) and it is on a
// different route, so a first-party sync-render regression is ruled out.
//
// The `Minified React error #327;` message is React's canonical production
// wording for the re-entrancy guard — a real first-party `throw new Error(
// 'Should not already be working.')` in app code would surface as that exact
// string, so the matcher anchors on React's minified-error format (`#327;`)
// rather than the bare message text, AND a NEGATIVE guard: if any frame
// resolves to a de-minified first-party `apps/web/src/…` source path, the event
// keeps reporting (our own code IS the re-entrant culprit → actionable). A
// real first-party #327 surfaces with a resolved `apps/web/src/…` frame and is
// preserved; only React-internal minified-chunk captures with no first-party
// frame are dropped. Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare `#327` match there would swallow a real first-party
// re-entrancy regression; the frame-aware `beforeSend` hook (which calls this
// helper) is the only safe gate.
const REACT_SCHEDULER_REENTRY_NOISE_PATTERN = /^Minified React error #327;/;

/**
 * Whether a Sentry / window.onerror event is the Firefox-specific React
 * scheduler re-entrancy noise class: a `Minified React error #327;` (the
 * canonical React production wording for `Should not already be working.`)
 * thrown from React's own production reconciler chunk (function `iX` in the
 * React DOM bundle's `ensureRootIsScheduled`/`performConcurrentWorkOnRoot`
 * continuation → `iu` (`performSyncWorkOnRoot`), which throws when
 * `executionContext & (RenderContext | CommitContext)` is set). The throw is
 * inside React's own minified production chunk, never first-party; it is a
 * well-known Firefox-specific scheduler quirk that does not reproduce on
 * Chromium/WebKit (see `REACT_SCHEDULER_REENTRY_NOISE_PATTERN` for refs).
 * Requires the `#327;` message AND a NEGATIVE guard: if any frame resolves to
 * a de-minified first-party `apps/web/src/…` source, the event keeps reporting
 * (our own code is the re-entrant culprit → actionable). Returns false when
 * there are no frames (can't confirm the throw is React-internal — keep
 * reporting rather than swallow a possible app re-entrancy regression). See
 * `REACT_SCHEDULER_REENTRY_NOISE_PATTERN` for the full rationale.
 */
export function isFirefoxReactSchedulerReentryNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown } | undefined>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (!REACT_SCHEDULER_REENTRY_NOISE_PATTERN.test(message)) {
    return false;
  }
  const frames = input.frames ?? [];
  // No frames at all → can't confirm the throw is React-internal; keep
  // reporting rather than blanket-dropping frameless events of unknown origin.
  if (frames.length === 0) {
    return false;
  }
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our own
  // code is the re-entrant culprit (e.g. a real `flushSync` inside a render
  // phase, or a sync `setState` during commit) → actionable; keep reporting so
  // the call site can be found + fixed.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Anchor: the throw must be inside React's own minified production bundle
  // (`_next/static/chunks/…`). A real first-party `throw new Error('Should not
  // already be working.')` de-minifies to `apps/web/src/…` and is preserved by
  // the negative guard above; a #327 from a non-React third-party lib (which
  // would surface with a different chunk frame) is preserved too. Only the
  // React-internal #327 with no first-party frame is dropped.
  return frames.some((frame) => isBrowserBundleSource(frame?.filename));
}

// Sentry 10.x's GlobalHandlers `onunhandledrejection` integration synthesizes a
// placeholder message when a promise rejects with a value that is NOT an Error
// instance (no `.message`/`.stack` to extract). For the primitive `undefined`,
// it emits the canonical
//   "Non-Error promise rejection captured with value: undefined"
// with NO stacktrace frames at all (there is nothing to de-minify — the
// rejection carries no stack). This is Sentry's generic signature for a
// fire-and-forget `.then()` (or async-init race) somewhere in the page that
// rejected with a bare `undefined`, OR a third-party script (analytics / cookie
// banner / tag manager) whose own promise rejected with `undefined`. The
// breadcrumbs around the production event are all third-party fetches on the
// marketing site (`/api/github-stars`, `/_vercel/insights/view`,
// `cdn-cookieyes.com`, `/api/maintenance`) plus the recurring
// `Unsupported color format var(--kortix-orange)` console.error — i.e. a
// third-party/cookie-library runtime, not first-party app code.
//
// Better Stack pattern
// 5cfc90e5077a4f3d956f46b51beb633256b9a74532717d4b5797ca5cbc62f2f1
// (Kortix Frontend prod, application_id 2346967): `UnhandledRejection`, 1
// occurrence, 0 identified users (anonymous), mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT global
// unhandledrejection — never reached any React error boundary), release
// `470fe6f3c88460212c3b187f6f86fb4ad456c4d6`, first 2026-04-23 / last
// 2026-07-22, Safari 26.5.2 on iOS 18.7 (iPhone, Mobile), request URL
// `https://kortix.com/` (the marketing/landing page). Stack trace: NONE —
// `call_site_file`/`call_site_function` are null, `call_stack_hash` is null,
// no frames at all. A bare `onunhandledrejection` capture of `undefined`.
//
// DISTINCT from the EIP-1193 wallet-extension plain-object rejection class
// (`isExtensionRejectedObjectNoise` / Better Stack `0f78b2f8…`, PR #4720):
// that one rejects with a serialized OBJECT (`{ code, message, stack }`) and
// Sentry emits "Object captured as promise rejection with keys: …" (which
// carries the extension stack in `extra.__serialized__.stack`). THIS class
// rejects with the primitive `undefined` and Sentry emits
// "Non-Error promise rejection captured with value: undefined" with no
// serialized payload and no frames. The two message prefixes are disjoint, so
// the matchers do not shadow each other.
//
// The "Non-Error promise rejection captured with value: undefined" message is
// Sentry's generic signature for ANY `Promise.reject(undefined)` — a real
// first-party `Promise.reject(undefined)` (e.g. a code path that resolves a
// promise with `undefined` on an error branch instead of throwing) would
// produce the SAME signature — so matching on the message alone is too broad.
// Require BOTH the canonical message AND a NEGATIVE guard: if the event has
// ANY resolved stack frame OR a resolved first-party `apps/web/src/…` frame,
// keep reporting (a real first-party `Promise.reject(undefined)` we can
// attribute should still surface). The production noise pattern has NO frames
// at all; only the frameless capture is dropped. Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there would swallow a real first-party
// `Promise.reject(undefined)` the negative guard exists to preserve; the
// frame-aware `beforeSend` hook (which calls this helper) is the only safe
// gate.
const NON_ERROR_UNDEFINED_REJECTION_PATTERN =
  /^Non-Error promise rejection captured with value: undefined$/;

/**
 * Whether a Sentry event is the bare-`undefined` non-Error promise rejection
 * noise class: Sentry 10.x's GlobalHandlers `onunhandledrejection`
 * integration captured a promise that rejected with the primitive `undefined`
 * (not an Error), and synthesized the canonical
 * "Non-Error promise rejection captured with value: undefined" message with NO
 * stacktrace frames. This is a fire-and-forget `.then()` or a third-party
 * script (analytics / cookie banner) on the marketing site whose promise
 * rejected with bare `undefined` — never first-party app code. Requires the
 * canonical message AND a NEGATIVE guard: if any frame resolves to a
 * de-minified first-party `apps/web/src/…` source path OR any resolvable
 * frame location at all, the event keeps reporting (a real first-party
 * `Promise.reject(undefined)` we can attribute should still surface). The
 * production noise pattern has NO frames; only the frameless capture is
 * dropped. See `NON_ERROR_UNDEFINED_REJECTION_PATTERN` for the full rationale.
 */
export function isNonErrorUndefinedRejectionNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const message = normalizeString(input.message);
  if (!NON_ERROR_UNDEFINED_REJECTION_PATTERN.test(message)) {
    return false;
  }
  const frames = input.frames ?? [];
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame means our
  // own code rejected a promise with `undefined` → actionable; keep reporting
  // so the call site can be found + fixed.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Negative guard #2: any resolvable source location (real chunk/URL/named
  // file) → an attributable error with a real stack; keep reporting. Only the
  // frameless capture (the production noise pattern) remains → drop it.
  if (frames.some((frame) => isResolvableFrameSource(frame?.filename))) {
    return false;
  }
  return true;
}

// Browser-internal DOM/binding `OperationError` noise — `Instance dropped in
// popErrorScope`. `popErrorScope` is part of the WebIDL/internal error-scope
// machinery (DOMQueuingStrategy, ResizeObserver, IntersectionObserver, media
// streams, GPU, …), NOT a first-party Kortix API. Some browser code paths
// (Firefox-originated; also emitted by some Chromium/Edge paths) surface a
// frameless `OperationError: Instance dropped in popErrorScope` as an
// unhandled promise rejection via the global `onunhandledrejection` handler.
// Better Stack pattern
// 5e1aca208331fa2d7540c9810b815b6c94f1373c470ff54e15f39d389dac7e0c
// (Kortix Frontend prod, application_id 2346967): `OperationError`, 2
// occurrences EVER across a 90-day window (first 2026-04-28 18:41:18 UTC on
// `https://www.kortix.com/instances` Chrome/Win, last 2026-07-22 18:26:35 UTC
// on `https://kortix.com/projects/<id>` reached from Google account sign-in
// Chrome/Edge/Win), 0 identified users (anonymous), mechanism
// `auto.browser.global_handlers.onunhandledrejection` (`handled:false` —
// UNCAUGHT, never reached a React error boundary). The exception payload is
// `{"values":[{"type":"OperationError","value":"Instance dropped in
// popErrorScope","mechanism":{"type":"auto.browser.global_handlers.
// onunhandledrejection","handled":false}}]}` — NO `stacktrace`, NO frames, NO
// `call_site_file`/`call_site_function`, NO `call_stack_hash`. A real
// first-party `Promise.reject(new OperationError(...))` carries a stack with
// `apps/web/src/…` frames, so the frameless shape is the noise signature.
//
// The same family as the prior frameless browser-internal rejection noise
// matchers — `isNonErrorUndefinedRejectionNoise` (PR #5200, pattern
// `5cfc90e5…`) and `isFirefoxReactSchedulerReentryNoise` (PR #5185, pattern
// `0f03b24e…`).
//
// `OperationError` is the WebIDL type for async DOM operations, NOT a Kortix
// error class, and it is a GENERIC type a real first-party
// `new OperationError(...)` could also surface with — so the matcher anchors on
// the EXACT message `/^Instance dropped in popErrorScope$/` (case-sensitive),
// never on the bare `OperationError` type. It additionally requires the
// frameless shape as a positive guard (no resolvable frame / no
// `call_site_file` / no stack) — the production noise pattern carries NO
// stack — mirroring the negative-guard pattern from PR #5200's
// `isNonErrorUndefinedRejectionNoise`: any resolved first-party
// `apps/web/src/…` frame → KEEP reporting (a real first-party `OperationError`
// rejection with a stack is preserved); any other resolvable frame location →
// keep reporting. Only the frameless capture is dropped. Deliberately NOT
// added to `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no
// frame context, so a bare-string match there could swallow a real first-party
// `OperationError` rejection the negative guard exists to preserve; the
// frame-aware `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`)
// is the only safe gate.
const OPERATION_ERROR_POP_ERROR_SCOPE_PATTERN =
  /^Instance dropped in popErrorScope$/;

/**
 * Whether a Sentry event is the browser-internal DOM/binding
 * `OperationError: Instance dropped in popErrorScope` noise class:
 * `popErrorScope` is part of the WebIDL/internal error-scope machinery
 * (DOMQueuingStrategy, ResizeObserver, IntersectionObserver, media streams,
 * GPU, …), NOT a first-party Kortix API. Some browser code paths surface a
 * frameless `OperationError` with this exact message as an uncaught global
 * `onunhandledrejection` — never first-party app code. Requires the EXACT
 * message (case-sensitive; `OperationError` alone is a generic WebIDL type a
 * real first-party `new OperationError(...)` could also surface with) AND a
 * NEGATIVE guard: if any frame resolves to a de-minified first-party
 * `apps/web/src/…` source path OR any resolvable frame location at all, the
 * event keeps reporting (a real first-party `OperationError` rejection we can
 * attribute should still surface). The production noise pattern has NO frames
 * at all; only the frameless capture is dropped. See
 * `OPERATION_ERROR_POP_ERROR_SCOPE_PATTERN` for the full rationale.
 */
export function isOperationErrorPopErrorScopeNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const message = normalizeString(input.message);
  if (!OPERATION_ERROR_POP_ERROR_SCOPE_PATTERN.test(message)) {
    return false;
  }
  const frames = input.frames ?? [];
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame means our
  // own code rejected a promise with an `OperationError` → actionable; keep
  // reporting so the call site can be found + fixed.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Negative guard #2: any resolvable source location (real chunk/URL/named
  // file) → an attributable error with a real stack; keep reporting. Only the
  // frameless capture (the production noise pattern) remains → drop it.
  if (frames.some((frame) => isResolvableFrameSource(frame?.filename))) {
    return false;
  }
  return true;
}

// Supabase gotrue `TOKEN_EXPIRED` auth-session rejection noise — a Supabase
// auth session JWT expired mid-flight (during a page load after a Google OAuth
// redirect, or during a stale session transition), and a fire-and-forget
// `.then()` on a Supabase auth call (e.g. `supabase.auth.getUser()` or session
// refresh) rejected with the plain gotrue error object
// `{ code: 400, message: "TOKEN_EXPIRED", status: "INVALID_ARGUMENT" }`.
// Because the rejected value is a plain object (NOT an Error), Sentry's
// GlobalHandlers `onunhandledrejection` integration cannot extract a stack from
// it: it serializes the object's own enumerable keys into `extra.__serialized__`
// and sets the exception value to the synthetic
// "Object captured as promise rejection with keys: code, message, status" with
// NO stacktrace frames. Better Stack pattern
// 63b0cde714048bca4c42129afacd5f8ec56813e0e663fbdb41265fdba6ed28a4
// (Kortix Frontend prod, application_id 2346967): `UnhandledRejection`, 2
// occurrences, 0 identified users (anonymous), first 2026-08-01 13:22:03 UTC,
// last 2026-08-01 13:22:27 UTC, mechanisms
// `auto.browser.global_handlers.onunhandledrejection` (`handled:false` —
// UNCAUGHT, never reached a React error boundary), `synthetic:true`, releases
// `c330eda4d96e7aee557618254a86df7d16ba5d9b` (v0.12.0), request URLs
// `https://kortix.com/auth` (first occurrence) and
// `https://kortix.com/projects/c5a6e2f5-8880-4c30-bbbf-40fbcc1a1fbf` (second
// occurrence, referer `https://accounts.google.com/` post-Google OAuth), Chrome
// 151.0.0.0 on Windows. Breadcrumbs: `https://supa.kortix.com/auth/v1/user`
// (Supabase gotrue), `/_vercel/insights/view`, google-analytics,
// `/api/maintenance`, cookieyes — marketing/analytics + the Supabase user fetch.
// The `__serialized__` extra is `{"code":400,"message":"TOKEN_EXPIRED","status":"INVALID_ARGUMENT"}`.
// Stack trace: NONE — `call_site_file`/`call_site_function` are null,
// `call_stack_hash` is null, no frames at all.
//
// DISTINCT from the EIP-1193 wallet-extension plain-object rejection class
// (`isExtensionRejectedObjectNoise`, PR #4720, Better Stack `0f78b2f8…`):
// that one rejects with `{ code, message, stack }` (keys include `stack` with
// an extension content-script origin) and the message is "Object captured as
// promise rejection with keys: code, message, stack". THIS class rejects with
// `{ code, message, status }` (keys include `status` instead of `stack`) and
// the message is "Object captured as promise rejection with keys: code, message,
// status". The two matchers are disjoint because the wallet-extension matcher
// requires a serialized `stack` with an extension-origin protocol prefix, which
// this event lacks (no `stack` key in `__serialized__`). The wallet-extension
// matcher's `SYNTHETIC_OBJECT_REJECTION_PATTERN` is a prefix match
// (`/^Object captured as promise rejection with keys:/`) that would match BOTH
// messages, but the extension-origin stack check rejects this event (there is
// no `stack` key), so the wallet-extension matcher returns false for this class.
//
// The synthetic "Object captured as promise rejection with keys: code, message,
// status" message is Sentry's generic signature for ANY non-Error plain-object
// rejection whose enumerable keys are `code`, `message`, `status`. A real
// first-party `Promise.reject({ code: 400, message: "TOKEN_EXPIRED", status:
// "INVALID_ARGUMENT" })` would produce the SAME signature — so matching on the
// message alone would swallow a real app bug. Require BOTH the exact message
// (with the specific `code, message, status` key set) AND a NEGATIVE guard: if
// the event has ANY resolved stack frame OR a resolved first-party
// `apps/web/src/…` frame, keep reporting (a real first-party
// `Promise.reject({ code, message, status })` we can attribute should still
// surface). The production noise pattern has NO frames at all; only the
// frameless capture is dropped. Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there would swallow a real first-party
// plain-object rejection the negative guard exists to preserve; the frame-aware
// `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`) is the only
// safe gate.
const SUPABASE_TOKEN_EXPIRED_REJECTION_PATTERN =
  /^Object captured as promise rejection with keys: code, message, status$/;

/**
 * Whether a Sentry event is the Supabase gotrue `TOKEN_EXPIRED` auth-session
 * rejection noise class: a Supabase auth session JWT expired mid-flight (during
 * a page load after a Google OAuth redirect, or during a stale session
 * transition), and a fire-and-forget `.then()` on a Supabase auth call rejected
 * with the plain gotrue error object `{ code: 400, message: "TOKEN_EXPIRED",
 * status: "INVALID_ARGUMENT" }`. Sentry's GlobalHandlers
 * `onunhandledrejection` integration serializes the plain object's enumerable
 * keys into `extra.__serialized__` and sets the exception value to the
 * synthetic "Object captured as promise rejection with keys: code, message,
 * status" with NO stacktrace frames. Requires the EXACT message (with the
 * specific `code, message, status` key set — distinct from the wallet-extension
 * `code, message, stack` key set matched by `isExtensionRejectedObjectNoise`)
 * AND a NEGATIVE guard: if any frame resolves to a de-minified first-party
 * `apps/web/src/…` source path OR any resolvable frame location at all, the
 * event keeps reporting (a real first-party `Promise.reject({ code, message,
 * status })` we can attribute should still surface). The production noise
 * pattern has NO frames at all; only the frameless capture is dropped. See
 * `SUPABASE_TOKEN_EXPIRED_REJECTION_PATTERN` for the full rationale.
 */
export function isSupabaseTokenExpiredNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const message = normalizeString(input.message);
  if (!SUPABASE_TOKEN_EXPIRED_REJECTION_PATTERN.test(message)) {
    return false;
  }
  const frames = input.frames ?? [];
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame means our
  // own code rejected a promise with a `{ code, message, status }` object →
  // actionable; keep reporting so the call site can be found + fixed.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Negative guard #2: any resolvable source location (real chunk/URL/named
  // file) → an attributable error with a real stack; keep reporting. Only the
  // frameless capture (the production noise pattern) remains → drop it.
  if (frames.some((frame) => isResolvableFrameSource(frame?.filename))) {
    return false;
  }
  return true;
}

// Supabase gotrue `Object Not Found Matching Id:…, MethodName:update,
// ParamCount:…` OTP-expired-link rejection noise. When a user lands on an
// expired/invalid OTP email link, the auth error page is served at
// `/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`,
// and the Supabase auth client tries to update the session from the expired
// OTP token in the URL hash. gotrue rejects the update server-side with a
// plain-string error `Object Not Found Matching Id:<n>, MethodName:update,
// ParamCount:<n>` (the gotrue RPC "no row found" wording for the session-update
// call — `<n>` varies per call). Because the rejected value is a bare STRING
// (NOT an Error instance), Sentry 10.x's GlobalHandlers `onunhandledrejection`
// integration cannot extract a `.message`/`.stack` from it: it synthesizes the
// canonical
//   "Non-Error promise rejection captured with value: Object Not Found
//    Matching Id:2, MethodName:update, ParamCount:4"
// (the rejection value inlined after `value: `) with NO stacktrace frames at
// all — there is no Error object to de-minify. Better Stack pattern
// e9a720020c921fbf82323125c20714fd7455e803295cf13aa624440de6d35e8e
// (Kortix Frontend prod, application_id 2346967): `UnhandledRejection`,
// 116 occurrences, 0 identified users (anonymous), first 2026-06-02 /
// recurring, mechanism `auto.browser.global_handlers.onunhandledrejection`
// (`handled:false` — UNCAUGHT, never reached a React error boundary),
// `synthetic:true`, release
// `160f0b286f0ad5c53debc343d5e055241694e24d` (v0.12.4 prod), request URL
// `https://kortix.com/#error=access_denied&error_code=otp_expired&error_
// description=Email+link+is+invalid+or+has+expired` (the auth error page —
// the OTP-expired redirect). Browser Chrome 142 on Windows 10. Breadcrumbs:
// `[runtime-env]` with `supabaseUrl: https://supa.kortix.com` (the Supabase
// auth client initializing), then a navigation to the same
// `#error=otp_expired` URL, then marketing-site fetches
// (`/api/github-stars`, `/_vercel/insights/view`, `/api/maintenance`) — the
// Supabase auth client's session-update rejecting on the expired-OTP error
// page. Stack trace: NONE — the raw exception payload is
// `{"values":[{"type":"UnhandledRejection","value":"Non-Error promise
// rejection captured with value: Object Not Found Matching Id:2,
// MethodName:update, ParamCount:4","mechanism":{"type":"auto.browser.
// global_handlers.onunhandledrejection","handled":false}}]}` with NO
// `stacktrace` key, NO frames, NO `call_site_file`/`call_site_function`,
// NO `call_stack_hash`.
//
// The `Id:2, MethodName:update, ParamCount:4` suffix varies per gotrue call
// (the `<n>` integers are the RPC's internal ids/counts), so the matcher
// anchors on the STABLE prefix
// `/^Non-Error promise rejection captured with value: Object Not Found
// Matching/` and lets the variable suffix match — every OTP-expired
// session-update rejection from gotrue shares this exact prefix.
//
// SIBLING of `isNonErrorUndefinedRejectionNoise` (PR #5200, pattern
// `5cfc90e5…`) and `isSupabaseTokenExpiredNoise` (pattern `63b0cde7…`):
// all three are frameless non-Error promise rejections from the Supabase
// auth client / third-party scripts on the auth/marketing pages, captured by
// Sentry's GlobalHandlers `onunhandledrejection` integration as a synthetic
// "Non-Error promise rejection captured with value: <value>" /
// "Object captured as promise rejection with keys: …" message with NO frames.
// The `undefined` matcher (#5200) rejects with the primitive `undefined`;
// the `TOKEN_EXPIRED` matcher rejects with a `{ code, message, status }`
// object (Sentry emits "Object captured as promise rejection with keys: …");
// THIS matcher rejects with a bare STRING (Sentry emits "Non-Error promise
// rejection captured with value: <string>"). The three message prefixes are
// disjoint, so the matchers do not shadow each other. Distinct from the EIP-1193
// wallet-extension plain-object rejection class (`isExtensionRejectedObject
// Noise`, PR #4720): that one rejects with `{ code, message, stack }` and
// Sentry emits "Object captured as promise rejection with keys: code,
// message, stack" (carrying the extension stack).
//
// The "Non-Error promise rejection captured with value: Object Not Found
// Matching…" prefix is Sentry's generic signature for ANY non-Error promise
// rejection whose value string starts with `Object Not Found Matching` — a
// real first-party `Promise.reject('Object Not Found Matching Id:…')` (e.g.
// a code path that rejects with a bare string on an error branch instead of
// throwing an Error) would produce the SAME signature, so matching on the
// message alone is too broad. Require BOTH the canonical prefix AND a
// NEGATIVE guard: if the event has ANY resolved stack frame OR a resolved
// first-party `apps/web/src/…` frame, keep reporting (a real first-party
// bare-string rejection we can attribute should still surface). The
// production noise pattern has NO frames at all; only the frameless capture
// is dropped. Deliberately NOT added to `sentry.client.config.ts`'s
// `ignoreErrors` list — that gate has no frame context, so a bare-string
// match there would swallow a real first-party bare-string rejection the
// negative guard exists to preserve; the frame-aware `beforeSend` hook
// (which calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const NON_ERROR_OBJECT_NOT_FOUND_REJECTION_PATTERN =
  /^Non-Error promise rejection captured with value: Object Not Found Matching/;

/**
 * Whether a Sentry event is the Supabase gotrue OTP-expired-link
 * `Object Not Found Matching Id:…, MethodName:update, ParamCount:…`
 * non-Error promise rejection noise class: a user landed on an expired/invalid
 * OTP email link (`/#error=access_denied&error_code=otp_expired`), and the
 * Supabase auth client's session-update from the expired OTP token rejected
 * with a bare string `Object Not Found Matching Id:<n>, MethodName:update,
 * ParamCount:<n>` (gotrue's "no row found" wording for the session-update RPC;
 * the `<n>` integers vary per call). Because the rejected value is a bare
 * string (NOT an Error), Sentry 10.x's GlobalHandlers `onunhandledrejection`
 * integration cannot extract a stack and synthesizes the canonical
 * "Non-Error promise rejection captured with value: Object Not Found
 * Matching Id:2, MethodName:update, ParamCount:4" message with NO stacktrace
 * frames. Requires the canonical prefix (the `Id:…, MethodName:…,
 * ParamCount:…` suffix varies per gotrue call) AND a NEGATIVE guard: if any
 * frame resolves to a de-minified first-party `apps/web/src/…` source path OR
 * any resolvable frame location at all, the event keeps reporting (a real
 * first-party bare-string `Promise.reject('Object Not Found Matching…')` we
 * can attribute should still surface). The production noise pattern has NO
 * frames at all; only the frameless capture is dropped. Sibling of
 * `isNonErrorUndefinedRejectionNoise` (PR #5200) and
 * `isSupabaseTokenExpiredNoise`. See
 * `NON_ERROR_OBJECT_NOT_FOUND_REJECTION_PATTERN` for the full rationale.
 */
export function isNonErrorObjectNotFoundRejectionNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const message = normalizeString(input.message);
  if (!NON_ERROR_OBJECT_NOT_FOUND_REJECTION_PATTERN.test(message)) {
    return false;
  }
  const frames = input.frames ?? [];
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame means our
  // own code rejected a promise with the bare-string gotrue value → actionable;
  // keep reporting so the call site can be found + fixed.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Negative guard #2: any resolvable source location (real chunk/URL/named
  // file) → an attributable error with a real stack; keep reporting. Only the
  // frameless capture (the production noise pattern) remains → drop it.
  if (frames.some((frame) => isResolvableFrameSource(frame?.filename))) {
    return false;
  }
  return true;
}

// Transient WebSocket / Server-Sent-Events (SSE) transport-close noise.
// `Connection closed.` is the CANONICAL transport-close message a client-side
// WebSocket/SSE library throws when the server closes the connection — a deploy
// / restart, an idle-timeout recycle, the session ending, or the load balancer
// recycling the upstream. The `/dashboard` realtime surface holds a background
// websocket/SSE connection; when the upstream tears the connection down during
// a deploy/idle-recycle, the library throws `Connection closed.` (the trailing
// `.` is part of the library's canonical close string). Better Stack pattern
// ecac86df82aca61f579836c1b813a0ed02cabd4a480b581db2f1ba5f4e20ab86
// (Kortix Frontend prod, application_id 2346967): `Error`, 1 occurrence / 0
// identified users, last 2026-07-23 16:44:09 UTC, release
// `470fe6f3c88460212c3b187f6f86fb4ad456c4d6` (v0.10.13), transaction
// `/dashboard`, URL `https://kortix.com/dashboard`, mechanism
// `auto.browser.global_handlers.onerror` (`handled:false` — UNCAUGHT, never
// reached a React error boundary), browser Chrome 150 / Windows 10. The single
// stack frame is the minified main co-worker runtime chunk
// `app:///_next/static/chunks/66499-652b83425f671b38.js?dpl=dpl_…` function `t`
// (lineno 15, colno 73840, in_app) — NO first-party `apps/web/src/…` frame.
// ZERO breadcrumbs (no fetches, no UI clicks) — a sparse capture, consistent
// with a background transport teardown fired before any user activity was
// recorded. The connection closing during a deploy/idle-recycle is EXPECTED; it
// is not a product bug. This is the same transient-transport class as the
// gateway-502 retry (#4609) and the frameless browser-internal rejections
// (#5200 / #5237 / #5185), but a WebSocket/SSE close on the `/dashboard`
// realtime surface.
//
// The orchestrator's sweep ledger has a HISTORICAL skip-list note about
// `Connection closed (transient SSE)` (pattern `6c28b5b4…`, noted ~2026-07-15)
// but NO code matcher existed for it (the note was a manual decision, not code)
// — this matcher codifies that decision into a real, tested gate.
//
// `Connection closed.` is generic enough that a real first-party
// `throw new Error('Connection closed.')` regression in our own websocket/SSE
// handling would surface with the SAME wording — so, mirroring
// `isOperationErrorPopErrorScopeNoise` / the Paper Shaders matchers, this
// matcher anchors on the EXACT message (case-sensitive, WITH the trailing
// period — a different message `Connection closed` (no period), or
// `Connection closed by server`, keeps reporting) and carries a NEGATIVE guard:
// if ANY frame resolves to a de-minified first-party `apps/web/src/…` source,
// the event keeps reporting (a real first-party `throw new Error('Connection
// closed.')` regression de-minifies to `apps/web/src/…` and must not be
// hidden). The prod event has only a minified `66499` chunk frame, so the
// negative guard does not fire for it. A frameless capture with this exact
// message still classifies as noise — the message alone is the library's
// canonical close string and is specific enough (unlike the bare-`undefined`
// rejection class, NO frameless-positive guard is required; the message + the
// first-party negative guard is sufficient). But when frames ARE present, the
// first-party negative guard MUST run. Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there would swallow a real first-party
// `Connection closed.` regression the negative guard exists to preserve; the
// frame-aware `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`)
// is the only safe gate.
const CONNECTION_CLOSED_NOISE_PATTERN = /^Connection closed\.$/;

/**
 * Whether a Sentry / window.onerror event is the transient WebSocket /
 * Server-Sent-Events (SSE) transport-close noise class: a client-side
 * WebSocket/SSE library threw the canonical `Connection closed.` message when
 * the server closed a background realtime connection (deploy / restart / idle-
 * timeout recycle / session end / load-balancer upstream recycle). The
 * connection closing during a deploy/idle-recycle is EXPECTED, not a product
 * bug. Requires the EXACT message (case-sensitive, WITH the trailing period —
 * the library's canonical close string; `Connection closed` without the period,
 * or `Connection closed by server`, keeps reporting) AND a NEGATIVE guard: if
 * any frame (or the window.onerror `filename`) resolves to a de-minified
 * first-party `apps/web/src/…` source path, the event keeps reporting (a real
 * first-party `throw new Error('Connection closed.')` regression de-minifies to
 * `apps/web/src/…` and must not be hidden). The prod event carries only a
 * minified `66499` chunk frame, so the negative guard does not fire for it. A
 * frameless capture with this exact message still classifies as noise — the
 * message alone is the library's canonical close string. See
 * `CONNECTION_CLOSED_NOISE_PATTERN` for the full rationale.
 */
// Safari generic SecurityError noise — the bare `The operation is insecure.`
// message that Safari 26.6+ on iOS throws for cross-origin restricted API
// access (`crypto.subtle`, `fetch` in a restricted context, or a Web Crypto
// operation in a sandboxed iframe / Safari private-mode context). This is a
// SIBLING of `isStorageSecurityErrorNoise` (which covers the storage-specific
// `SecurityError: Failed to read the 'localStorage'/'sessionStorage' property
// from 'Window'` wording) — the storage matcher does NOT match the bare
// `The operation is insecure.` message because its regex anchors on the
// storage property name `'localStorage'`/`'sessionStorage'`.
//
// Better Stack frontend prod patterns
//   e1d25be3ab38488ba0bfb2b3f069f24641914e3d20bacc1027178a5522376294
//   1918c62ac5434aa56d7ce150e96b99be1b520471360fa3ef091802327297cf73
//   70e1c309921716ee01cd5cd083cef876b41a81311b51db3d5bd55def644fdc47
//   1cec609ee07b7f15aea6fea1eed550e4ce45a838abdf40171050336ff4abc2aa
// (Kortix Frontend prod, application_id 2346967): all `SecurityError: The
// operation is insecure.`, 1 occurrence each / 0 identified users, last
// 2026-07-29 08:36:02 UTC, release `c330eda4d96e7aee557618254a86df7d16ba5d9b`
// (v0.11.0 — POST-Promote), transaction `/` (marketing homepage), URL
// `https://kortix.com/`, browser Safari 26.6 on iOS (iPhone) 18.7, mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT). Frames: all
// in `webpack-befb5b1662175048.js` function `a` (webpack runtime) +
// `59675-a333ed5b0ae6dae4.js` functions `17725`/`20532`/`63613` (in_app) —
// NO first-party `apps/web/src/…` frame.
//
// The EXACT message `The operation is insecure.` is Safari's canonical
// security-error string for cross-origin restricted API access (never a
// first-party throw), so matching on the exact message alone is safe. BUT a
// NEGATIVE guard preserves any event whose stack carries a resolved first-party
// `apps/web/src/…` frame (a real first-party `SecurityError` with this message
// would be a first-party code regression → actionable). Unlike the storage
// SecurityError sibling, a frameless capture with this exact message still
// classifies as noise — the message is Safari-specific and generic enough that
// a frameless capture with this exact message is still Safari's own WebKit
// internals, never first-party code.
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list —
// that gate has no frame context, so a bare-string match there could swallow a
// real first-party `SecurityError` regression the negative guard exists to
// preserve. The frame-aware `beforeSend` hook (which calls
// `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const SAFARI_GENERIC_SECURITY_ERROR_NOISE_MESSAGE = /^The operation is insecure\.$/;

/**
 * Whether a Sentry / window.onerror event is the Safari generic `SecurityError:
 * The operation is insecure.` noise class — Safari 26.6+ on iOS throws this for
 * cross-origin restricted API access (`crypto.subtle`, `fetch` in a restricted
 * context, or a Web Crypto operation in a sandboxed iframe / Safari private-mode
 * context). This is a SIBLING of `isStorageSecurityErrorNoise` (which covers the
 * storage-specific `SecurityError: Failed to read the 'localStorage'/'sessionStorage'
 * property from 'Window'` wording); the storage matcher does NOT catch the bare
 * `The operation is insecure.` message because its regex anchors on the storage
 * property name.
 *
 * Requires the EXACT message `The operation is insecure.` (case-sensitive,
 * Safari's canonical security error string) AND a NEGATIVE guard: if any frame
 * (or the window.onerror filename) resolves to a de-minified first-party
 * `apps/web/src/…` source, the event keeps reporting — a real first-party
 * `SecurityError` with this message would be a first-party code regression and
 * is actionable. Only events with NO resolved first-party frame are dropped.
 * A frameless capture with this exact message still classifies as noise (the
 * message is Safari-specific and generic enough that a frameless capture with
 * this exact message is still Safari's own WebKit internals, never first-party
 * code). See `SAFARI_GENERIC_SECURITY_ERROR_NOISE_MESSAGE` for the full rationale
 * and the four Better Stack patterns.
 */
export function isSafariGenericSecurityErrorNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown }>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!SAFARI_GENERIC_SECURITY_ERROR_NOISE_MESSAGE.test(stripped)) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party frame means our own code threw this
  // SecurityError — actionable (a real first-party code regression), keep
  // reporting so the call site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
}

export function isConnectionClosedNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  // `stripErrorWrappers` strips `Unhandled promise rejection: ` and
  // `<Word>Error: ` (e.g. `SyntaxError: `, `TypeError:`) but NOT a bare
  // `Error: ` prefix (the regex requires ≥1 letter before `Error`). A bare
  // `Error: Connection closed.` is the form an `onunhandledrejection` of an
  // `Error` instance serializes to, so strip that leading `Error: ` too before
  // anchoring on the library's exact canonical close string.
  const stripped = stripErrorWrappers(normalizeString(input.message))
    .replace(/^Error: /, '');
  if (!CONNECTION_CLOSED_NOISE_PATTERN.test(stripped)) {
    return false;
  }
  // Collect every source location — the window.onerror `filename` (runtime
  // gate) and any stacktrace frames (Sentry gate) — for the first-party
  // negative guard.
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our
  // own websocket/SSE handling threw `Connection closed.` → actionable
  // regression; keep reporting so the call site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
}

// Transient WebSocket `postMessage` "Failed to send message" transport
// noise — a SIBLING of `isConnectionClosedNoise` (the `Connection closed.`
// transport-close class) but a DIFFERENT throw. The co-worker session page
// (`/projects/:id/sessions/:sessionId`) holds a WebSocket connection to the
// sandbox runtime; when the sandbox tears the connection down mid-flight
// (a deploy / restart / idle-timeout recycle / sandbox park / network
// blip / the user closing the tab), a fire-and-forget `ws.send(...)` on the
// already-closed socket rejects with the canonical
// `Failed to send message` (the WebSocket spec's `InvalidStateError`
// message — `ReadyState is not OPEN`). The throw fires from a react-query
// mutation's `mutationFn` (a minified `Object.x [as mutationFn]` in a
// `_next/static/immutable/chunks/…` bundle), is caught by an error
// boundary (`handled:true`, mechanism `generic` — NOT an UNCAUGHT global
// rejection; the boundary showed the user an error state instead of a
// blank page), and Sentry captures it as an exception with ONE minified
// chunk frame — NO resolved first-party `apps/web/src/…` source.
//
// This is the same transient-transport class as
// `isConnectionClosedNoise` (PR for BS `ecac86df…`) and the broader
// `isFramelessNetworkErrorNoise` family — a WebSocket/SSE transport
// teardown that is EXPECTED (the sandbox closing is not a product bug),
// self-healing-on-reconnect, and surfaces only as a transient transport
// error. The `handled:true` means the error boundary already showed the
// user a controlled error state (not a blank page), so it is doubly not
// actionable — the user saw a controlled state, and the connection
// recovers on the next session switch.
//
// Better Stack pattern
// 824577dd315c08f227a1f31c74e2eb90be209b1ffd129e18923907aa3068afd2
// (Kortix Frontend prod, application_id 2346967): `Error`, message
// `Failed to send message`, 1 occurrence / 0 identified users, last
// 2026-08-11 14:47:00 UTC, release
// `cd9dfccec1fb7e41a6726e9e45fd678cf428cc3a` (v0.12.8 prod), call site
// function `Object.x [as mutationFn]`, call site file
// `app:///_next/static/immutable/chunks/3n0z0jtixhg6r.js` (minified — NO
// resolved first-party source), request URL a co-worker session page
// (`https://kortix.com/projects/834686a1-…/sessions/54f7abe9-…`), browser
// Chrome on macOS, mechanism `generic` with `handled:true` (CAUGHT by an
// error boundary — NOT an uncaught global rejection). Stack frames (1,
// `in_app:true`):
//   1. `app:///_next/static/immutable/chunks/3n0z0jtixhg6r.js` fn
//      `Object.x [as mutationFn]` (the react-query mutation that called
//      `ws.send(...)` on the closed socket — a minified bundle chunk, NOT a
//      resolved first-party source path).
// NO first-party `apps/web/src/…` frame.
//
// The `Failed to send message` wording is the WebSocket spec's canonical
// `InvalidStateError` message for `ws.send(...)` on a closed socket — it
// is GENERIC enough that a real first-party sender regression (our own
// `ws.send` on a closed socket, surfacing from a de-minified
// `apps/web/src/…` call site) would throw the SAME wording. Because the
// event is `handled:true` (caught by an error boundary — the user saw a
// controlled error state, not a blank page), a first-party sender IS
// actionable: if our own code is the sender, the boundary's error state
// is showing the user a defect we should fix. So this matcher anchors on
// BOTH the EXACT message AND a NEGATIVE guard: if ANY frame (or the
// window.onerror `filename`) resolves to a de-minified first-party
// `apps/web/src/…` source path, the event KEEPS reporting — our own code
// is the `ws.send` caller and a real first-party transport regression is
// actionable to fix. Only events with NO resolved first-party frame (the
// production noise shape: a minified `_next/static/immutable/chunks/…`
// frame, or frameless) are dropped. A frameless capture with this exact
// message still classifies as noise — the message alone is the WebSocket
// spec's canonical transport-failure wording and is specific enough
// (the `Failed to send message` string paired with the
// `ws.send`-on-closed-socket context pins this single transport class),
// mirroring `isConnectionClosedNoise`'s frameless handling. Deliberately
// NOT added to `sentry.client.config.ts`'s `ignoreErrors` list — that gate
// has no frame context, so a bare-string match there would swallow a real
// first-party `ws.send` regression the negative guard exists to preserve;
// the frame-aware `beforeSend` hook (which calls
// `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const FAILED_TO_SEND_MESSAGE_NOISE_PATTERN = /^Failed to send message$/;

/**
 * Whether a Sentry / window.onerror event is the transient WebSocket
 * `postMessage` "Failed to send message" transport-noise class: a co-worker
 * session page's WebSocket `ws.send(...)` rejected with the canonical
 * WebSocket `InvalidStateError` message (`Failed to send message` — the
 * spec's wording for `ws.send` on a closed socket) when the sandbox tore
 * the connection down mid-flight (deploy / restart / idle-timeout recycle /
 * sandbox park / network blip / tab close). This is a SIBLING of
 * `isConnectionClosedNoise` (the `Connection closed.` transport-close
 * class) but a DIFFERENT throw — a `ws.send` rejection on an already-closed
 * socket, NOT a library close event. The connection closing during a
 * deploy/recycle is EXPECTED, not a product bug; the event is
 * `handled:true` (caught by an error boundary — the user saw a controlled
 * error state, not a blank page).
 *
 * Requires the EXACT message `Failed to send message` (case-sensitive, the
 * WebSocket spec's canonical `InvalidStateError` wording) AND a NEGATIVE
 * guard: if ANY frame (or the window.onerror `filename`) resolves to a
 * de-minified first-party `apps/web/src/…` source path, the event KEEPS
 * reporting — our own code is the `ws.send` caller and a real first-party
 * transport regression is actionable (the boundary already showed the user
 * a controlled error state, so we should fix the sender). Only events with
 * NO resolved first-party frame (the production noise shape: a minified
 * `_next/static/immutable/chunks/…` frame, or frameless) are dropped. A
 * frameless capture with this exact message still classifies as noise.
 * See `FAILED_TO_SEND_MESSAGE_NOISE_PATTERN` for the full rationale and
 * Better Stack pattern `824577dd…`.
 */
export function isFailedToSendMessageNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message))
    .replace(/^Error: /, '');
  if (!FAILED_TO_SEND_MESSAGE_NOISE_PATTERN.test(stripped)) {
    return false;
  }
  // Collect every source location — the window.onerror `filename` (runtime
  // gate) and any stacktrace frames (Sentry gate) — for the first-party
  // negative guard.
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our
  // own code is the `ws.send` caller on a closed socket → a real first-party
  // transport regression (the boundary already showed the user an error
  // state); keep reporting so the call site can be found + fixed. A real
  // first-party `ws.send` regression de-minifies to `apps/web/src/…` and is
  // never hidden.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
}

// Third-party editor-library document-state race noise. A ProseMirror/TipTap-
// based editor library (`@tiptap/*` deps in `apps/web/package.json`) holds an
// internal document-state map keyed by document id. When the editor is
// unmounted / the document is closed while an async interaction or selection
// is still in flight (a race in the library's own async interaction handling,
// fired by WebKit's async timing differing from Chrome's), the library
// throws from its OWN internal state-lookup helpers:
//   - `getDocumentStateOrThrow` → `Interaction state not found for document: <docId>`
//   - `getDocumentState`        → `Selection state not found for document: <docId>`
// Both are library-internal functions in a minified `_next/static/chunks/…`
// bundle (e.g. `17631.2j-4o95.js`), NEVER in first-party `apps/web/src/…`
// source (grep confirms no first-party `getDocumentStateOrThrow` /
// `getDocumentState`). The throw is captured by Sentry's
// `BrowserApiErrors.addEventListener` / `setInterval` / global
// `onerror`/`onunhandledrejection` auto-wrappers as an UNCAUGHT event
// (`handled:false`, never reaches a React error boundary) and leaks to Better
// Stack.
//
// Better Stack patterns (Kortix Frontend prod, application_id 2346967):
//   - `6d6fa794a67a293ce9fa5d093648a9d76a2dd243e04f4f9dd9fbbd67bfb0c9ef`:
//     `Error`, message
//     `Interaction state not found for document: doc-1785904808253-gbsixyvii`,
//     call_site_function `getDocumentStateOrThrow`, call_site_file
//     `app:///_next/static/chunks/17631.2j-4o95.js`, 28 occurrences / 0
//     identified users, last 2026-08-05 04:40:45 UTC (POST-v0.12.3),
//     mechanism `auto.browser.browserapierrors.addEventListener` (UNCAUGHT,
//     `handled:false`), request URL
//     `https://kortix.com/projects/e1d956a3-…/sessions/be897489-…` (session
//     page), Safari 26.5 on macOS (WebKit). Frames: `r @ 13jg6.ewllp.z.js` →
//     `v @ 17631.2j-4o95.js` → `getActiveMode @ 17631.2j-4o95.js` →
//     `getDocumentStateOrThrow @ 17631.2j-4o95.js` — NO first-party
//     `apps/web/src/…` frame.
//   - `a954c7e7553065986e8177c68b82ccf3c3d83d6eabb413700974b2a11f841fb7`:
//     `Error`, message
//     `Selection state not found for document: doc-1785904808253-gbsixyvii`
//     (SAME doc id as the interaction sibling), call_site_function
//     `getDocumentState`, SAME call_site_file
//     `app:///_next/static/chunks/17631.2j-4o95.js`, 2 occurrences, same
//     timestamp as the interaction sibling.
//
// These are noise, not a product bug:
//   1. UNCAUGHT (`handled:false`, `addEventListener`/`onunhandledrejection`)
//      — never reached a React error boundary.
//   2. Third-party library internal — `getDocumentStateOrThrow` /
//      `getDocumentState` are library-internal helpers in a minified chunk,
//      NOT first-party `apps/web/src/…` code.
//   3. Safari-specific — WebKit's async timing differs from Chrome's,
//      triggering the editor's internal state-map race.
//   4. 28+2 occurrences from a SINGLE session (`be897489-…`) in a short window
//      — a transient race, not a persistent bug.
//
// The `<Interaction|Selection> state not found for document:` prefix is the
// library's OWN canonical wording for its internal state-lookup failure
// (the `for document:` suffix names the library's document-state map), and
// `getDocumentStateOrThrow` / `getDocumentState` are library-internal
// function names never present in first-party code, so anchoring on the
// message prefix is conservative. BUT a first-party `throw new Error(
// 'Interaction state not found for document: …')` regression would surface
// with a resolved `apps/web/src/…` frame, so a NEGATIVE guard MUST preserve
// any event whose stack carries a resolved first-party frame. Only events
// with NO resolved first-party frame (the production noise shape: all frames
// in the minified `17631` / `13jg6` library chunks) are dropped. Deliberately
// NOT added to `sentry.client.config.ts`'s `ignoreErrors` list — that gate
// has no frame context, so a bare-string match there could swallow a real
// first-party state-lookup regression the negative guard exists to preserve;
// the frame-aware `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`)
// is the only safe gate.
const DOCUMENT_STATE_NOT_FOUND_NOISE_PATTERN =
  /^(Interaction|Selection) state not found for document:/;

/**
 * Whether a Sentry / window.onerror event is the third-party editor-library
 * (ProseMirror/TipTap-based) document-state race noise class: the library's
 * own internal `getDocumentStateOrThrow` / `getDocumentState` helpers threw
 * `<Interaction|Selection> state not found for document: <docId>` when the
 * editor was unmounted / the document closed while an async interaction or
 * selection was still in flight (a race in the library's async interaction
 * handling, triggered by WebKit's async timing). The throw is in the
 * library's minified chunk (`17631.2j-4o95.js`), never first-party. Requires
 * the canonical message prefix AND a NEGATIVE guard: if any frame (or the
 * window.onerror `filename`) resolves to a de-minified first-party
 * `apps/web/src/…` source path, the event keeps reporting (a real first-party
 * `throw new Error('Interaction state not found for document: …')`
 * regression de-minifies to `apps/web/src/…` and must not be hidden). The
 * production noise pattern carries only minified `17631`/`13jg6` library
 * chunk frames, so the negative guard does not fire for it. A frameless
 * capture with this exact message prefix still classifies as noise (the
 * `for document:` suffix names the library's document-state map and the
 * message wording is library-specific). See
 * `DOCUMENT_STATE_NOT_FOUND_NOISE_PATTERN` for the full rationale and the
 * two Better Stack patterns `6d6fa794…` / `a954c7e7…`.
 */
export function isDocumentStateNotFoundNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!DOCUMENT_STATE_NOT_FOUND_NOISE_PATTERN.test(stripped)) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our
  // own code threw this state-lookup message → a real first-party regression;
  // keep reporting so the call site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
}


// Bare lowercase `network error` rejection noise — the canonical Axios /
// `XMLHttpRequest` transport-abort message. Axios throws this (or the
// capitalized `Network Error` wrapper — a DIFFERENT surface, see below) when a
// request fails at the transport layer (DNS failure, connection refused, TLS
// abort, CORS preflight rejection, or the server dropping the connection
// mid-flight). The underlying XHR `onerror` emits the lowercase `network error`
// string; Axios wraps it as `new Error('Network Error')` (capitalized) for its
// own rejection. This matcher targets ONLY the bare lowercase form.
//
// Better Stack pattern
// 2403c9ba5deee2af387834e95461cfb32b9b5080b21d6f307b2f09bb09e71f21
// (Kortix Frontend prod, application_id 2346967): `TypeError`, message
// `network error` (lowercase, bare), 1 occurrence / 0 identified users, last
// 2026-07-23 16:53:55 UTC, release
// `470fe6f3c88460212c3b187f6f86fb4ad456c4d6` (v0.10.13), transaction
// `/projects/:id/sessions/:sessionId` (co-worker session page), mechanism
// `auto.browser.global_handlers.onunhandledrejection` (`handled:false` —
// UNCAUGHT, never reached a React error boundary), Chrome 150 on Generic
// Linux. Stack frames: ZERO — `stacktrace.frames` is an empty array, no
// `call_site_file`, no `call_site_function`, no `call_stack_hash`. Breadcrumbs:
// 100 total, 88 fetches, 0 non-200 (so no fetch visibly failed with a non-200
// in the captured window — the rejection is a fire-and-forget `.then()` or a
// network-abort that didn't surface a status). This is the same session that
// hit the 25s-deadline + audit 503s — a degraded-network user.
//
// With ZERO frames and an UNCAUGHT `onunhandledrejection`, this is a
// fire-and-forget `.then()` whose rejection was never caught — likely a
// third-party script (analytics, the CookieYes cookie banner, Vercel insights)
// or an app fetch whose `.catch()` was missing, on a degraded network. It is
// the same family as the prior frameless browser-internal rejection noise
// matchers — `isNonErrorUndefinedRejectionNoise` (PR #5200, pattern
// `5cfc90e5…`), `isOperationErrorPopErrorScopeNoise` (PR #5237, pattern
// `5e1aca20…`), and `isFirefoxReactSchedulerReentryNoise` (PR #5185, pattern
// `0f03b24e…`).
//
// The message is GENERIC — a real first-party unhandled rejection that throws
// `new Error('network error')` (or `Promise.reject('network error')`) would
// surface with the SAME message — so the matcher requires BOTH:
//   1. The EXACT bare message `network error` (lowercase, case-sensitive,
//      after `stripErrorWrappers`). The capitalized `Network Error` (Axios's
//      own wrapper Error) is a DIFFERENT surface and is deliberately NOT
//      matched — it is left to report so a blanket-silence does not hide a
//      real Axios rejection we may want to triage. A near-worded message such
//      as `network error: failed to fetch` is also NOT matched (only the EXACT
//      bare string is noise).
//   2. A FRAMELESS positive guard: the event has NO resolvable frames (empty
//      `stacktrace.frames` AND no resolvable `filename`/`call_site` anywhere)
//      — mirroring `isOperationErrorPopErrorScopeNoise` /
//      `isNonErrorUndefinedRejectionNoise`. A real first-party
//      `new Error('network error')` throw almost always has a stack with a
//      resolvable frame (chunk URL or `apps/web/src/…`), so requiring
//      framelessness is the over-match guard.
// Plus TWO negative guards (mirror the frameless-noise matchers): (a) any
// resolved first-party `apps/web/src/…` frame → keep reporting; (b) ANY
// resolvable frame location (chunk/URL/named file) → keep reporting. Only the
// FRAMELESS capture is dropped. Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there would swallow a real first-party
// `new Error('network error')` the negative guard exists to preserve; the
// frame-aware `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`)
// is the only safe gate.
const FRAMELESS_NETWORK_ERROR_MESSAGE = 'network error';

/**
 * Whether a Sentry event is the bare lowercase `network error` rejection noise
 * class: the canonical Axios / `XMLHttpRequest` transport-abort message (lower-
 * case; distinct from Axios's capitalized `Network Error` wrapper, which is a
 * different surface and is NOT matched), captured as an uncaught global
 * `onunhandledrejection` with NO resolvable stack frames. A fire-and-forget
 * `.then()` or a third-party script (analytics / cookie banner / tag manager)
 * on a degraded network whose promise rejected with the bare transport-abort
 * string; never attributable first-party app code. Requires the EXACT bare
 * message (case-sensitive, after `stripErrorWrappers`) AND NEGATIVE guards:
 * any resolved first-party `apps/web/src/…` frame OR any resolvable frame
 * location → keep reporting (a real first-party `new Error('network error')`
 * we can attribute should still surface). The production noise pattern has NO
 * frames at all; only the frameless capture is dropped. See
 * `FRAMELESS_NETWORK_ERROR_MESSAGE` for the full rationale.
 */
export function isFramelessNetworkErrorNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (message !== FRAMELESS_NETWORK_ERROR_MESSAGE) {
    return false;
  }
  const frames = input.frames ?? [];
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame means our
  // own code threw/rejected with `new Error('network error')` → actionable;
  // keep reporting so the call site can be found + fixed.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Negative guard #2: any resolvable source location (real chunk/URL/named
  // file) → an attributable error with a real stack; keep reporting. Only the
  // frameless capture (the production noise pattern) remains → drop it.
  if (frames.some((frame) => isResolvableFrameSource(frame?.filename))) {
    return false;
  }
  return true;
}

// Bot / automation-framework / scraper `Cannot redefine property: webdriver`
// noise. A headless-browser or automation tool (Selenium, Puppeteer, Playwright,
// or a scraper) injects a script that attempts
// `Object.defineProperty(navigator, 'webdriver', { get: () => undefined })` to
// hide its automation footprint from bot-detection on the page it is crawling.
// In some Chrome builds `navigator.webdriver` is a NON-configurable property,
// so the `defineProperty` trap throws `TypeError: Cannot redefine property:
// webdriver`. The throw originates in the injected automation/anti-detection
// script — NEVER in first-party Kortix code — and surfaces as an UNCAUGHT global
// `onerror` (mechanism `auto.browser.global_handlers.onerror`, `handled:false`
// — never reaches a React error boundary). Better Stack pattern
// ee14e84d1a150ae094e20722e619083499d8b29206445a2ef349ff42db6d0f7f
// (Kortix Frontend prod, application_id 2346967): `TypeError`, message
// `Cannot redefine property: webdriver`, call site function
// `Object.defineProperty`, call site file `<anonymous>`, 1 occurrence / 0
// identified users, first 2026-08-12 07:49:16 UTC, request URL
// `https://kortix.com/projects/61df2bc0-…` (project page), browser Chrome on
// Windows 10. Stack: 3 frames, ALL `<anonymous>` (functions `?`, `?`,
// `Object.defineProperty`) — NO resolved first-party `apps/web/src/…` frame
// and NO chunk frame at all. This is bot/scanner noise, NOT a product bug: a
// real first-party `Object.defineProperty` call that redefined a non-
// configurable property would de-minify to `apps/web/src/…` frames (Sentry
// uploads sourcemaps), and `navigator.webdriver` is never touched by
// first-party app code.
//
// The EXACT message `Cannot redefine property: webdriver` is the V8/Chrome
// canonical `TypeError` for a `defineProperty` on a non-configurable property
// (the property name `webdriver` pins it to `navigator.webdriver` specifically,
// never a coincidental app-logic `defineProperty` regression). BUT the matcher
// carries a NEGATIVE guard: if ANY frame (or the window.onerror `filename`)
// resolves to a de-minified first-party `apps/web/src/…` source path, the event
// keeps reporting — a real first-party `defineProperty` regression
// de-minifies to `apps/web/src/…` and must not be hidden. The production event
// carries only `<anonymous>` frames, so the negative guard does NOT fire for
// it. A frameless capture with this exact message still classifies as noise
// — the `webdriver` property name is the specific anchor (it is never a
// first-party Kortix API surface). Deliberately NOT added to
// `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
// context, so a bare-string match there could swallow a real first-party
// `defineProperty` regression the negative guard exists to preserve; the
// frame-aware `beforeSend` hook (which calls `shouldIgnoreSentryBrowserNoise`)
// is the only safe gate.
const REDEFINE_WEBDRIVER_NOISE_MESSAGE = /^Cannot redefine property: webdriver$/;

/**
 * Whether a Sentry / window.onerror event is the bot / automation-framework /
 * scraper `Cannot redefine property: webdriver` noise class: an injected
 * anti-detection script attempts
 * `Object.defineProperty(navigator, 'webdriver', …)` to hide its automation
 * footprint, and Chrome throws a `TypeError` because `navigator.webdriver` is
 * non-configurable in that build. The throw originates in the injected
 * automation script, never first-party Kortix code. Requires the EXACT message
 * (case-sensitive; the `webdriver` property name pins it to
 * `navigator.webdriver` specifically) AND a NEGATIVE guard: if any frame (or
 * the window.onerror `filename`) resolves to a de-minified first-party
 * `apps/web/src/…` source path, the event keeps reporting (a real first-party
 * `defineProperty` regression de-minifies to `apps/web/src/…` and must not be
 * hidden). The production event carries only `<anonymous>` frames, so the
 * negative guard does NOT fire for it. A frameless capture with this exact
 * message still classifies as noise — the `webdriver` property name is the
 * specific anchor. See `REDEFINE_WEBDRIVER_NOISE_MESSAGE` for the full
 * rationale and Better Stack pattern `ee14e84d…`.
 */
export function isRedefineWebdriverNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!REDEFINE_WEBDRIVER_NOISE_MESSAGE.test(stripped)) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame (or
  // window.onerror `filename`) means our own code called `defineProperty` on a
  // non-configurable property → a real first-party regression; keep reporting
  // so the call site can be found + fixed. A real first-party `defineProperty`
  // regression de-minifies to `apps/web/src/…` and is never hidden.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
}

// Transient fetch-abort `signal timed out` noise — the Bun / native
// `TimeoutError` raised by `AbortSignal.timeout()` when a client-side fetch
// exceeds its 30s deadline. This is the SAME transient-timeout class as the
// prior API pattern `c672fb5e…` which was fixed by PR #4709 (API-side
// `SENTRY_IGNORE_ERRORS` filter for `'The operation timed out.'`). The existing
// API-side filter covers `'The operation timed out.'` but NOT the frontend's
// `'signal timed out'` wording. The SDK's `makeRequest` aborts on its 30s
// deadline and the abort surfaces as `TimeoutError: signal timed out` in the
// frontend's `onunhandledrejection` handler (the rejection reaches Sentry
// through a fire-and-forget path that bypasses `handleApiError`'s timeout
// guard). The SDK already has a bounded retry for transient gateway statuses
// (#4609) and the API already filters its own timeout (#4709), but the
// frontend rejection still reaches Sentry.
//
// Better Stack pattern
// 73e683c3aad440ccf4cc817f0484366cc66ba26b9435517fc8c86d4f7d258d60
// (Kortix Frontend prod, application_id 2346967): `TimeoutError`, message
// `signal timed out`, 24 occurrences / 0 identified users, first 2026-05-16
// (recurring), last 2026-08-12 04:08:45 UTC, mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT,
// `handled:false`), request URL
// `https://kortix.com/projects/…/sessions/…` (session pages), browser Chrome
// on macOS, tags `DOMException.code: 23` (InvalidStateError — the network
// abort). Stack: NONE — the exception value has NO `stacktrace` key at all
// (frameless capture). A transient network/timeout error, not a code bug.
//
// The EXACT message `signal timed out` is the canonical `TimeoutError` message
// from `AbortSignal.timeout()` — it is specific enough to anchor on without a
// frame guard (a real first-party `throw new Error('signal timed out')` would
// be unusual). For conservativism, the matcher carries an OPTIONAL negative
// guard: if ANY frame (or the window.onerror `filename`) resolves to a
// de-minified first-party `apps/web/src/…` source path, the event keeps
// reporting (a real first-party `signal timed out` throw de-minifies to
// `apps/web/src/…` and must not be hidden). The production event has NO frames
// at all, so the negative guard does NOT fire for it. A frameless capture
// with this exact message classifies as noise — the message is the canonical
// `AbortSignal.timeout()` wording. Sibling to `isClientRequestTimeoutMessage`
// (the SDK's typed `Request timed out after <N>s:` wording, #4531) — this is
// the NATIVE `TimeoutError` wording the bare `AbortSignal.timeout()` promise
// rejection surfaces with, distinct from the SDK's wrapped `ApiError`
// message. Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors`
// list — that gate has no frame context; the frame-aware `beforeSend` hook
// (which calls `shouldIgnoreSentryBrowserNoise`) is the safe gate.
const SIGNAL_TIMEOUT_NOISE_MESSAGE = /^signal timed out$/;

/**
 * Whether a Sentry / window.onerror event is the transient fetch-abort
 * `signal timed out` noise class: the native `TimeoutError` raised by
 * `AbortSignal.timeout()` when a client-side fetch exceeds its 30s deadline.
 * The SDK's `makeRequest` aborts on its 30s deadline and the abort surfaces as
 * `TimeoutError: signal timed out` in the frontend's `onunhandledrejection`
 * handler; it reaches Sentry through a fire-and-forget path that bypasses
 * `handleApiError`'s timeout guard. A transient network/timeout error, not a
 * code bug. Requires the EXACT message (case-sensitive; the canonical
 * `AbortSignal.timeout()` `TimeoutError` wording) AND a NEGATIVE guard: if
 * any frame (or the window.onerror `filename`) resolves to a de-minified
 * first-party `apps/web/src/…` source path, the event keeps reporting (a real
 * first-party `signal timed out` throw de-minifies to `apps/web/src/…` and
 * must not be hidden). The production event has NO frames at all, so the
 * negative guard does NOT fire for it. A frameless capture with this exact
 * message classifies as noise. Sibling of `isClientRequestTimeoutMessage` (the
 * SDK's typed `Request timed out after <N>s:` wording). See
 * `SIGNAL_TIMEOUT_NOISE_MESSAGE` for the full rationale and Better Stack
 * pattern `73e683c3…`.
 */
export function isSignalTimeoutNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  if (!SIGNAL_TIMEOUT_NOISE_MESSAGE.test(stripped)) {
    return false;
  }
  const sources = [
    input.filename,
    ...(input.frames ?? []).map((frame) => frame?.filename),
  ];
  // Negative guard: a resolved first-party `apps/web/src/…` frame (or
  // window.onerror `filename`) means our own code threw `signal timed out` →
  // a real first-party regression; keep reporting so the call site can be
  // found + fixed. A real first-party `signal timed out` throw de-minifies to
  // `apps/web/src/…` and is never hidden. The production event has NO frames,
  // so this guard does NOT fire for it.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
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

  // Safari generic SecurityError noise — the bare `The operation is insecure.`
  // message from Safari 26.6+ on iOS for cross-origin restricted API access
  // (`crypto.subtle`, `fetch` in a restricted context, or a Web Crypto operation
  // in a sandboxed iframe / Safari private-mode context). This is a SIBLING of
  // `isStorageSecurityErrorNoise` (which covers the storage-specific wording) —
  // the storage matcher does NOT catch the bare `The operation is insecure.`
  // message. See `isSafariGenericSecurityErrorNoise`.
  if (isSafariGenericSecurityErrorNoise({ message, filename: input.filename })) {
    return true;
  }

  // Transient WebSocket / SSE transport-close noise — a client-side
   // websocket/SSE library threw the canonical `Connection closed.` message when
   // the server closed a background realtime connection during a deploy / idle-
    // timeout recycle / session end. The connection closing is EXPECTED, not a
    // product bug. Requires the EXACT message (with trailing `.`) and a NEGATIVE
    // guard so a real first-party `throw new Error('Connection closed.')`
    // regression keeps reporting. See `isConnectionClosedNoise`.
    if (isConnectionClosedNoise({ message, filename: input.filename })) {
      return true;
    }

   // Transient WebSocket `postMessage` `Failed to send message` transport
   // noise — a co-worker session page's `ws.send(...)` rejected with the
   // canonical WebSocket `InvalidStateError` message when the sandbox tore
   // the connection down mid-flight (deploy / recycle / park / network
   // blip). Sibling of `isConnectionClosedNoise` but a different throw (a
   // `ws.send` rejection on a closed socket, not a library close event).
   // The event is `handled:true` (caught by an error boundary), so a
   // first-party sender IS actionable — the negative guard preserves any
   // resolved first-party `apps/web/src/…` frame. See
   // `isFailedToSendMessageNoise`.
    if (isFailedToSendMessageNoise({ message, filename: input.filename })) {
      return true;
    }

    // Third-party editor-library (ProseMirror/TipTap-based) document-state
    // race noise — the library's own internal `getDocumentStateOrThrow` /
    // `getDocumentState` helpers threw
    // `<Interaction|Selection> state not found for document: <docId>` when the
    // editor was unmounted / the document closed while an async interaction or
    // selection was still in flight (a race in the library's async interaction
    // handling, triggered by WebKit's async timing). Requires the canonical
    // message prefix AND a NEGATIVE guard: any resolved first-party
    // `apps/web/src/…` frame → keep reporting. See
    // `isDocumentStateNotFoundNoise`.
    if (isDocumentStateNotFoundNoise({ message, filename: input.filename })) {
      return true;
    }


   // Browser-native <img> / next/image load failures can surface as this exact
   // message through window.onerror. Keep this exact: the old pptx-react-viewer
   // threw actionable errors such as "Failed to load image for colour change
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

  // Expected server-side request-deadline 503 (API 25s wall-clock deadline) —
  // the API-side classification (#4524) de-noises it from the API's OWN Sentry,
  // but the 503 response crosses into the frontend as an `ApiError(status:
  // 503)` that `handleApiError` captures to the FRONTEND Sentry (Better Stack
  // pattern `a330bea1…`). It is the SAME expected/retryable degradation class
  // as the client timeout above; never page Better Stack for it. See
  // `isServerDeadlineNoiseMessage`.
  if (isServerDeadlineNoiseMessage(message)) {
    return true;
  }

  // Expected billing-gate 402 outcomes are user-facing business states handled
  // by a toast/upgrade dialog — never page Better Stack for them, even when the
  // SDK's `ApiError` reaches window.onerror / unhandledrejection before
  // `handleApiError` can gate it.
  if (isExpectedBillingGateMessage(message)) {
    return true;
  }

  // Expected "no compaction model configured" configuration state — the SDK's
  // `useSummarizeRuntimeSession` mutation throws a sentinel
  // `NoCompactionModelError` that the host already surfaces via a toast. It
  // leaks here as an unhandled promise rejection (`void loadingToast(...)`
  // re-throws after the toast → `onunhandledrejection`). Drop it so the
  // expected config state never pages Better Stack. See
  // `isExpectedCompactionNoModelMessage`.
  if (isExpectedCompactionNoModelMessage(message)) {
    return true;
  }

  // Expected "model not available for this account" UI validation state — the
  // API returns a typed 409 `code: 'model_not_servable'` when a user picks a
  // model their account can't use. The SDK's `useModelDefaults` `setMutation`
  // `onError` already surfaces a user-facing toast, and `makeRequest` already
  // classifies the typed 409 as SILENT to `onError` (Sentry) — but every call
  // site fire-and-forgets the returned promise (`void setXxxDefault(...)`), so
  // the rejected `mutateAsync` becomes an UNHANDLED rejection →
  // `onunhandledrejection`, which the #6082 SDK gate never sees (it's past the
  // `makeRequest` return). Drop it here so the expected validation state never
  // pages Better Stack. See `isModelNotServableNoise` and Better Stack pattern
  // `9784f440…`.
  if (isModelNotServableNoise(message)) {
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

  // Canvas `getImageData` out-of-memory noise — a third-party canvas library
  // (e.g. a decorative background / hyper-logo animation on the marketing
  // homepage) called `CanvasRenderingContext2D.getImageData()` and the browser
  // ran out of memory allocating the `ImageData` buffer, surfacing as the
  // canonical `Failed to execute 'getImageData' on 'CanvasRenderingContext2D':
  // Out of memory at ImageData creation` `RangeError`. TRANSIENT browser
  // resource exhaustion (canvas too large / tab under memory pressure / low-
  // RAM device), not a deterministic code bug. The throw fires from a
  // third-party library's `addEventListener` callback (Sentry's
  // `BrowserApiErrors` auto-wrapper captures it as UNCAUGHT, `handled:false`
  // — never reached a React error boundary). Requires the exact message AND a
  // NEGATIVE guard: a resolved first-party `apps/web/src/…` filename means our
  // own code is the `getImageData` caller → a real first-party OOM regression;
  // keep reporting. A frameless window.onerror capture with the exact message
  // + no first-party filename drops. See `isCanvasImageDataOOMNoise` and
  // Better Stack pattern `b4b43847…`.
  if (isCanvasImageDataOOMNoise({ message, filename: input.filename })) {
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

  // Old-browser third-party-library DOM null-deref noise on the marketing
  // homepage — `Cannot read properties of null (reading 'scrollLeft')` /
  // `… (reading 'appendChild')` (V8) / `Cannot read property '<X>' of null`
  // (old JSC) from minified third-party library internals (`measureScroll`,
  // `ft`) on very old browsers (Win7 Chrome, Chrome 95). Requires the exact
  // message AND a NEGATIVE guard: a resolved first-party `apps/web/src/…`
  // filename means our own code is the null-deref culprit → actionable; keep
  // reporting. A frameless window.onerror capture with the exact message + no
  // first-party filename drops. See `isOldBrowserDomNullDerefNoise`.
  if (isOldBrowserDomNullDerefNoise({ message, filename: input.filename })) {
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

  // Android System WebView native-bridge instrumentation noise — the
  // `postEvent` sibling of the `postMessage` class above. The WebView's
  // `JavaBridge` calls `postEvent` on a GC'd Java bridge object; the throw
  // escapes framelessly (`<anonymous>` / `?`). Requires the exact message AND
  // a frameless/injected-WebView origin so a real first-party
  // `postEvent`/`dispatchEvent` failure keeps reporting. See
  // `isAndroidWebViewNativeBridgePostEventNoise`.
  if (
    isAndroidWebViewNativeBridgePostEventNoise({
      message,
      filename: input.filename,
    })
  ) {
    return true;
  }

  // iOS WebKit (WKWebView) in-app-browser native-bridge instrumentation noise
  // — the iOS sibling of the Android bridge classes above. The iOS WebView
  // injects a synthetic `app:///` script that records navigation/performance
  // timing and ships it to `window.webkit.messageHandlers`; on iOS WebViews
  // where the WebKit bridge is unavailable, the access throws JSC's canonical
  // `undefined is not an object (evaluating 'window.webkit.messageHandlers')`.
  // Requires the EXACT message AND a positive `app:///`/instrumentation-
  // function anchor so a real first-party `window.webkit.messageHandlers`
  // access keeps reporting. The runtime gate sees the window.onerror
  // `filename`; the prod event carried `app:///` frames in the Sentry
  // stacktrace (handled by the Sentry gate below), but a runtime capture with
  // an `app:///` filename is also noise. See
  // `isIOSWebViewWebKitBridgeNoise`.
  if (
    isIOSWebViewWebKitBridgeNoise({
      message,
      filename: input.filename,
    })
  ) {
    return true;
  }

  if (isInjectedAppSource(input.filename)) {
    return true;
  }

  // Browser userscript-manager (Tampermonkey / Violentmonkey / Greasemonkey /
  // FireMonkey) injected user-script noise — the script's own logic bug (e.g.
  // `JSON.parse(undefined)` → `SyntaxError: "undefined" is not valid JSON`)
  // thrown from the synthetic `app:///userscript.html?…` wrapper page and
  // captured as an unhandled rejection. Third-party user-script defect, never
  // first-party app code; drop it. See `isUserscriptManagerNoise`.
  if (isUserscriptManagerNoise({ message, filename: input.filename })) {
    return true;
  }

  // OneTrust cookie-consent SDK JSON-parse noise — the third-party
  // `otSDKStub.js?did=undefined` bootstrap stub's `XMLHttpRequest.onload`
  // handler calls `JSON.parse()` on an empty/truncated consent-config
  // response (old iOS Safari, CORS preflight failure, 5xx, network abort)
  // and throws the canonical `SyntaxError: Unexpected end of JSON input`.
  // The throw is in the OneTrust SDK's own injected script, never first-
  // party code. Requires BOTH the exact message AND an `otSDKStub.js`
  // frame, with a negative guard preserving any resolved first-party
  // `apps/web/src/…` frame. See `isOneTrustJsonParseNoise`.
  if (isOneTrustJsonParseNoise({ message, filename: input.filename })) {
    return true;
  }

  // Browser-extension injectedScript.bundle.js `sendMessage` noise — a
  // browser extension injects `app:///injectedScript.bundle.js` that calls
  // `chrome.runtime.sendMessage` / `browser.runtime.sendMessage` on a
  // `runtime` object that is `undefined` in a non-extension context or after
  // tab teardown. Requires BOTH the `sendMessage` message anchor AND an
  // injected-app source, with a negative guard preserving any resolved
  // first-party `apps/web/src/…` frame. See `isInjectedScriptSendMessageNoise`.
  if (isInjectedScriptSendMessageNoise({ message, filename: input.filename })) {
    return true;
  }

  // CAPTCHA / anti-bot browser-extension interceptor noise — the extension's
  // injected `app:///content/captcha/mt_captcha/interceptor.js` races on widget
  // init and a minified function reads `widgetId` on an `undefined` widget
  // config → `TypeError: Cannot read properties of undefined (reading
  // 'widgetId')`. Requires BOTH the `widgetId` message anchor AND an
  // injected-app source, with a negative guard preserving any resolved
  // first-party `apps/web/src/…` frame. See `isCaptchaInterceptorNoise`.
  if (isCaptchaInterceptorNoise({ message, filename: input.filename })) {
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

  // Browser-extension EIP-1193 wallet-provider plain-object rejection noise —
  // a wallet extension rejects a pending request with a plain
  // `{ code, message, stack }` object (code 4900, "provider is disconnected").
  // The runtime gate receives the raw rejected object as `reason`/`error`
  // (whose `message` is the provider's own, NOT Sentry's synthetic "Object
  // captured as promise rejection …" wording), so anchor on the rejected
  // value's own `stack` tracing through a browser-extension content script.
  // A real Error from app code has a stack of app/chunk frames, never an
  // extension content-script frame, so this is conservative. See
  // `isExtensionRejectedObjectNoise` / `rejectedObjectHasExtensionStack`.
  if (
    rejectedObjectHasExtensionStack(input.reason)
    || rejectedObjectHasExtensionStack(input.error)
  ) {
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

  // Bot / automation-framework / scraper `Cannot redefine property: webdriver`
  // noise — an injected anti-detection script attempts
  // `Object.defineProperty(navigator, 'webdriver', …)` to hide its automation
  // footprint, and Chrome throws a `TypeError` because `navigator.webdriver`
  // is non-configurable in that build. The throw is in the injected
  // automation script, never first-party code. Requires the EXACT message AND
  // a NEGATIVE guard: a resolved first-party `apps/web/src/…` filename means
  // our own code called `defineProperty` on a non-configurable property → a
  // real first-party regression; keep reporting. The production event has
  // only `<anonymous>` frames, so the negative guard does NOT fire for it. A
  // frameless window.onerror capture with the exact message + no first-party
  // filename drops. See `isRedefineWebdriverNoise` and Better Stack pattern
  // `ee14e84d…`.
  if (isRedefineWebdriverNoise({ message, filename: input.filename })) {
    return true;
  }

  // Transient fetch-abort `signal timed out` noise — the native `TimeoutError`
  // raised by `AbortSignal.timeout()` when a client-side fetch exceeds its 30s
  // deadline. The SDK's `makeRequest` aborts on its 30s deadline and the abort
  // surfaces as `TimeoutError: signal timed out` in the frontend's
  // `onunhandledrejection`; it reaches the runtime gate through a fire-and-
  // forget path. The API already filters its OWN timeout wording
  // (`The operation timed out.`, #4709), but the frontend's `signal timed out`
  // wording is NOT covered. A transient network/timeout error, not a code
  // bug. Requires the EXACT message AND a NEGATIVE guard: a resolved
  // first-party `apps/web/src/…` filename means our own code threw
  // `signal timed out` → a real first-party regression; keep reporting. The
  // production event has NO frames, so the negative guard does NOT fire for
  // it. A frameless window.onerror capture with the exact message + no
  // first-party filename drops. See `isSignalTimeoutNoise` and Better Stack
  // pattern `73e683c3…`.
  if (isSignalTimeoutNoise({ message, filename: input.filename })) {
    return true;
  }

  return isExtensionSource(input.filename) && normalizeString(message).includes('runtime.sendMessage');
}

export function shouldIgnoreSentryBrowserNoise(event: {
  message?: unknown;
  extra?: unknown;
  request?: { url?: unknown };
  exception?: {
    values?: Array<{
      value?: unknown;
      mechanism?: { type?: unknown; handled?: unknown };
      stacktrace?: { frames?: Array<{ filename?: unknown }> };
    }>;
  };
}): boolean {
  const primaryException = event.exception?.values?.find(Boolean);
  const message = primaryException?.value ?? event.message;
  const frames = primaryException?.stacktrace?.frames ?? [];
  const mechanism = primaryException?.mechanism?.type;
  const handled = primaryException?.mechanism?.handled;
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

  // Safari generic SecurityError noise — the bare `The operation is insecure.`
  // message from Safari 26.6+ on iOS for cross-origin restricted API access
  // (`crypto.subtle`, `fetch` in a restricted context, or a Web Crypto operation
  // in a sandboxed iframe / Safari private-mode context). This is a SIBLING of
  // `isStorageSecurityErrorNoise` (which covers the storage-specific wording) —
  // the storage matcher does NOT catch the bare `The operation is insecure.`
  // message. See `isSafariGenericSecurityErrorNoise`.
  if (isSafariGenericSecurityErrorNoise({ message, frames })) {
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

  // Expected server-side request-deadline 503 (API 25s wall-clock deadline) —
  // the server-side mirror of the client timeout above. The API's
  // `RequestDeadlineHTTPException` returns a clean 503 + `Retry-After` with the
  // message `Request exceeded the <N>s server processing deadline`; the SDK
  // surfaces it as an `ApiError(status: 503)` that can leak to Sentry through
  // capture paths that bypass `handleApiError`'s deadline guard
  // (`<ClientErrorBoundary>` / route-error / app-error / `onunhandledrejection`).
  // Drop it so the expected deadline state never pages Better Stack. See
  // `isServerDeadlineNoiseMessage`.
  if (isServerDeadlineNoiseMessage(message)) {
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

  // Expected "no compaction model configured" configuration state — the SDK's
  // `useSummarizeRuntimeSession` mutation throws a sentinel
  // `NoCompactionModelError` that the host already surfaces via a toast. It
  // can leak to Sentry through capture paths that bypass the toast (the
  // `void loadingToast(...)` re-throw → `onunhandledrejection`, plus
  // `<ClientErrorBoundary>` / route / system-fault boundaries). Drop it here
  // so the expected config state never pages Better Stack. See
  // `isExpectedCompactionNoModelMessage`.
  if (isExpectedCompactionNoModelMessage(message)) {
    return true;
  }

  // Expected "model not available for this account" UI validation state — the
  // API returns a typed 409 `code: 'model_not_servable'` (and a 400
  // `INVALID_SESSION_MODEL` sibling with the SAME message) when a user picks a
  // model their account can't use. The SDK's `useModelDefaults` `setMutation`
  // `onError` already surfaces a user-facing toast, and `makeRequest` already
  // classifies the typed 409 as SILENT to `onError` (Sentry) (PR #6082), but
  // every call site fire-and-forgets the returned promise
  // (`void setXxxDefault(...)`), so the rejected `mutateAsync` becomes an
  // UNHANDLED rejection → Sentry's `onunhandledrejection` (`handled:false`),
  // which the #6082 SDK gate never sees (it's past the `makeRequest` return).
  // It can also leak through `<ClientErrorBoundary>` / route / system-fault
  // boundaries. Drop it here so the expected validation state never pages
  // Better Stack. The match is a REGEX (model name varies) anchored on the
  // exact API wording, with canonical wrappers; a longer real error that
  // merely mentions the phrase keeps reporting. See `isModelNotServableNoise`
  // and Better Stack pattern `9784f440…`.
  if (isModelNotServableNoise(message)) {
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

  // Paper Shaders WebGL-unsupported deliberate-throw noise — the library's
  // OWN canonical `Paper Shaders: WebGL is not supported in this browser`
  // `Error`, thrown from the library's shader-mount constructor when WebGL is
  // unavailable (stripped-down/mobile WebView, headless renderer, WebGL
  // disabled). A SIBLING of the null-context crash class above, but a
  // DIFFERENT throw (a deliberate library `Error`, not a null-context
  // `TypeError`). An EXPECTED degradation state on WebGL-less browsers;
  // never a product bug. Requires the exact library message AND a NEGATIVE
  // guard: a resolved first-party `apps/web/src/…` frame means our own code
  // threw this exact message (a real first-party regression) → keep
  // reporting. The production noise pattern carries only minified
  // `@paper-design/shaders` chunk frames. NOT in `ignoreErrors` (no frame
  // context there). See `isPaperShaderWebGLUnsupportedNoise`.
  if (isPaperShaderWebGLUnsupportedNoise({ message, frames })) {
    return true;
  }

  // Canvas `getImageData` out-of-memory noise — a third-party canvas library
  // (e.g. a decorative background / hyper-logo animation on the marketing
  // homepage) called `CanvasRenderingContext2D.getImageData()` and the browser
  // ran out of memory allocating the `ImageData` buffer, surfacing as the
  // canonical `Failed to execute 'getImageData' on 'CanvasRenderingContext2D':
  // Out of memory at ImageData creation` `RangeError`. This is TRANSIENT
  // browser resource exhaustion (canvas too large / tab under memory pressure
  // / low-RAM device), NOT a deterministic code bug — the same canvas renders
  // fine on the next visit. The throw fires from a third-party library's
  // `addEventListener` callback (Sentry's `BrowserApiErrors` auto-wrapper
  // captures it as UNCAUGHT, `handled:false` — never reached a React error
  // boundary). Requires the exact message AND a NEGATIVE guard: a resolved
  // first-party `apps/web/src/…` frame means our own code is the
  // `getImageData` caller → a real first-party OOM regression; keep reporting.
  // The prod event carries only minified third-party canvas library chunk
  // frames (no first-party source). NOT in `ignoreErrors` (no frame context
  // there). See `isCanvasImageDataOOMNoise` and Better Stack pattern
  // `b4b43847…`.
  if (isCanvasImageDataOOMNoise({ message, frames })) {
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

  // Old-browser third-party-library DOM null-deref noise on the marketing
  // homepage — `Cannot read properties of null (reading 'scrollLeft')` /
  // `… (reading 'appendChild')` (V8) / `Cannot read property '<X>' of null`
  // (old JSC) from minified third-party library internals (`measureScroll`,
  // `ft`) on very old browsers (Win7 Chrome, Chrome 95). Requires the exact
  // message AND a NEGATIVE guard: a resolved first-party `apps/web/src/…`
  // frame means our own code is the null-deref culprit → actionable; keep
  // reporting. The prod events carry only minified `app:///_next/static/
  // chunks/…` chunk frames + `<anonymous>`, so the negative guard does NOT
  // fire for them. A frameless capture with one of these exact messages still
  // classifies as noise. NOTE: deliberately NOT added to
  // `sentry.client.config.ts`'s `ignoreErrors` list — that gate has no frame
  // context, so a bare-string match there would swallow a real first-party
  // `el.scrollLeft` / `parent.appendChild` null-deref the negative guard
  // exists to preserve; the frame-aware `beforeSend` hook (which calls this
  // helper) is the only safe gate. See `isOldBrowserDomNullDerefNoise`.
  if (isOldBrowserDomNullDerefNoise({ message, frames })) {
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

  // Android System WebView native-bridge instrumentation noise — the
  // `postEvent` sibling of the `postMessage` class above, captured by Sentry's
  // global onerror/onunhandledrejection handlers. Unlike the `postMessage`
  // sibling, the `postEvent` variant is observed as a FRAMELESS capture
  // (`<anonymous>` / `?`), so it is anchored on the exact message AND a
  // frameless/injected-WebView origin (no resolvable source location, OR the
  // Android nav-performance-logger bridge frame). A genuine first-party
  // `postEvent`/`dispatchEvent` failure keeps reporting. Not in `ignoreErrors`
  // (no frame context there).
  if (isAndroidWebViewNativeBridgePostEventNoise({ message, frames })) {
    return true;
  }

  // iOS WebKit (WKWebView) in-app-browser native-bridge instrumentation noise
  // — the iOS sibling of the Android bridge classes above. The iOS WebView
  // injects a synthetic `app:///` script (THREE slashes — distinct from
  // Android's single-slash `app://navigation_performance_logger_android`)
  // that records navigation/performance timing
  // (`processLargestContentfulPaintEvent`) and ships it to
  // `window.webkit.messageHandlers`; on iOS WebViews where the WebKit bridge
  // is unavailable, the access throws JSC's canonical
  // `undefined is not an object (evaluating 'window.webkit.messageHandlers')`.
  // Captured as an UNCAUGHT global `onerror` (never reaches a React error
  // boundary). Requires the EXACT message AND a positive `app:///`/
  // instrumentation-function anchor (`sendDataToNative` /
  // `processLargestContentfulPaintEvent`) with a first-party negative guard,
  // so a real first-party `window.webkit.messageHandlers` access regression
  // (which de-minifies to `apps/web/src/…`) keeps reporting. Not in
  // `ignoreErrors` (no frame context there). See
  // `isIOSWebViewWebKitBridgeNoise`.
  if (isIOSWebViewWebKitBridgeNoise({ message, frames })) {
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

  // Browser userscript-manager (Tampermonkey / Violentmonkey / Greasemonkey /
  // FireMonkey) injected user-script noise — the script's own logic bug (e.g.
  // `JSON.parse(undefined)` → `SyntaxError: "undefined" is not valid JSON`)
  // thrown from the synthetic `app:///userscript.html?…` wrapper page and
  // captured as an unhandled rejection. Third-party user-script defect, never
  // first-party app code; drop it so a buggy user script someone installed on
  // their browser never pages Better Stack. A real first-party `JSON.parse`
  // SyntaxError throws inside an `app:///_next/…` chunk (or a de-minified
  // `apps/web/src/…` frame) and is never matched. See
  // `isUserscriptManagerNoise` and the production pattern `2249441898…`.
  if (isUserscriptManagerNoise({ message, frames })) {
    return true;
  }

  // OneTrust cookie-consent SDK JSON-parse noise — the third-party
  // `otSDKStub.js?did=undefined` bootstrap stub's `XMLHttpRequest.onload`
  // handler calls `JSON.parse()` on an empty/truncated consent-config
  // response (old iOS Safari, CORS preflight failure, 5xx, network abort)
  // and throws the canonical `SyntaxError: Unexpected end of JSON input`.
  // The throw is in the OneTrust SDK's own injected script (frame
  // `app:///scripttemplates/otSDKStub.js?did=undefined` function `r.onload`),
  // never first-party code. Requires BOTH the exact message AND an
  // `otSDKStub.js` frame, with a negative guard preserving any resolved
  // first-party `apps/web/src/…` frame. See `isOneTrustJsonParseNoise` and
  // the production pattern `aa1efd3fb…`.
  if (isOneTrustJsonParseNoise({ message, frames })) {
    return true;
  }

  // Browser-extension injectedScript.bundle.js `sendMessage` noise — a
  // browser extension (wallet / adblocker / privacy) injects
  // `app:///injectedScript.bundle.js` that calls `chrome.runtime.sendMessage`
  // on a `runtime` object that is `undefined` in a non-extension context or
  // after tab teardown. Requires BOTH the `sendMessage` message anchor AND
  // an `injectedScript.bundle.js` injected-source frame (or any injected-app
  // source), with a negative guard preserving any resolved first-party
  // `apps/web/src/…` frame. See `isInjectedScriptSendMessageNoise` and the
  // production pattern `95a70e66…`.
  if (isInjectedScriptSendMessageNoise({ message, frames })) {
    return true;
  }

  // CAPTCHA / anti-bot browser-extension interceptor noise — a bot-detection
  // service extension injects `app:///content/captcha/mt_captcha/interceptor.js`
  // whose internal `widgetId` configuration race throws
  // `TypeError: Cannot read properties of undefined (reading 'widgetId')` from
  // a minified extension function (`d`). The throw is in the extension's OWN
  // injected interceptor, never first-party code. Requires BOTH the `widgetId`
  // message anchor AND an injected-app source frame, with a negative guard
  // preserving any resolved first-party `apps/web/src/…` frame. See
  // `isCaptchaInterceptorNoise` and the two production patterns
  // `cfd5f828…` / `4a01a169…`.
  if (isCaptchaInterceptorNoise({ message, frames })) {
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

  // Wallet-extension injected-`inpage.js` "No error message" noise — a
  // SIBLING of the stream EventEmitter noise class above (`isInpageWalletStreamNoise`),
  // but a DIFFERENT throw: the wallet extension's `onGlobalMessage` →
  // `runIfPresent` → `run` handlers in `app:///inpage.js` throw a value that
  // has no `.message` property, so Sentry SDK 10.x writes the `"No error message"`
  // placeholder. The error propagates through the React reconciler and into the
  // `global-error` boundary, which Sentry's `onerror` handler then captures. The
  // stream-noise matcher does NOT catch this because its message markers
  // (`addListener`/`emit`) are absent — the message is the placeholder string
  // `"No error message"` instead. The `isEmptyMessageUnresolvedBrowserChunkNoise`
  // matcher also does NOT catch it because the `app:///inpage.js` frames are
  // NOT browser-bundle sources (the negative guard at line ~1072 requires ALL
  // frames to be browser bundle sources, and the extension frames violate that).
  //
  // Better Stack pattern
  // 61949432528f8a88c74799f2dc1a8dd128479ae49e6e75865f501e5eb40fc94e
  // (Kortix Frontend prod, application_id 2346967): `Error`, message
  // `No error message`, 1 occurrence / 0 identified users, last 2026-07-30
  // 09:14:21 UTC, route `/auth?expired=true&returnUrl=…`, mechanism
  // `auto.browser.global_handlers.onerror` (UNCAUGHT global error — never
  // reached a React error boundary directly, but the stack passes through
  // React's global-error boundary). Stack frames:
  //   - `app:///inpage.js` function `onGlobalMessage`
  //   - `app:///inpage.js` function `runIfPresent`
  //   - `app:///inpage.js` function `run`
  //   - React reconciler frames (`iX`, `iu`, `ib`, `ik`, `oq`, `o_`, `l9`, `l`)
  //   - `app:///_next/static/chunks/app/global-error-*.js` function `l`
  //   - ... React reconciler / chunk frames
  // NO first-party `apps/web/src/…` frame. Chrome 150 / Windows 10, React 19.2.0.
  //
  // The `app:///inpage.js` source is the same wallet-extension injected script
  // that `isInpageWalletStreamNoise` and `isInpageWalletInjectedSource` match.
  // Requires BOTH the `"No error message"` placeholder AND a frame from
  // `app:///inpage.js` (the wallet-extension injected source), with a NEGATIVE
  // guard: if any frame resolves to a de-minified first-party `apps/web/src/…`
  // source path, the event keeps reporting (a real first-party error with no
  // message that happens to have an inpage.js frame in the stack is still
  // actionable). Deliberately NOT added to `sentry.client.config.ts`'s
  // `ignoreErrors` list — that gate has no frame context, so a bare `"No error
  // message"` string match there would swallow a real first-party error with
  // no message that has no inpage.js frame; the frame-aware `beforeSend` hook
  // (which calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
  if (isInpageJsNoErrorMessageNoise({ message, frames })) {
    return true;
  }

  // Browser-extension EIP-1193 wallet-provider plain-object rejection noise —
  // a wallet extension rejects a pending request with a plain
  // `{ code, message, stack }` object (code 4900, "provider is disconnected"),
  // and Sentry captures it as a synthetic "Object captured as promise
  // rejection with keys: …" exception with NO stacktrace frames (the rejected
  // value is not an Error, so Sentry cannot extract a stack). The extension
  // origin lives ONLY in `extra.__serialized__.stack`, so the frame-aware
  // extension guards above miss it. Requires BOTH the synthetic signature AND
  // an extension-origin frame inside the serialized stack so a real first-party
  // `Promise.reject({...})` keeps reporting. See
  // `isExtensionRejectedObjectNoise`.
  if (isExtensionRejectedObjectNoise({ message, extra: event.extra, frames })) {
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

  // @embedpdf/plugin-tiling `TilingLayer` viewport-advance tile-destructure
  // noise — a SIBLING of the React #185 class above, but a DIFFERENT throw from a
  // different embedpdf tiling path: under a rapid scroll/zoom burst the tiling
  // plugin's tile queue drains mid-burst, the viewport-advance path
  // (`t5.advance` / `iA.ignore` / `iA.onScroll` / `IntersectionObserver.threshold`)
  // calls `const { tile } = queue.pop()` on an `undefined` pop result, and V8
  // throws `Cannot destructure property 'tile' of 'r.pop(...)' as it is
  // undefined.` The #4718 matcher (React #185 + `onTileRendering`) does NOT
  // catch it (different message, different frame anchor). Requires BOTH the
  // EXACT message AND a positive viewport-advance frame anchor, with a
  // first-party negative guard, so a real first-party `{ tile } = arr.pop()`
  // regression keeps reporting. See `isEmbedPdfTilingTileDestructureNoise`.
  if (isEmbedPdfTilingTileDestructureNoise({ message, frames })) {
    return true;
  }

  // Broader third-party-library React #185 "Maximum update depth exceeded"
  // fallback — runs AFTER the @embedpdf tiling #185 matcher above (the
  // tiling matcher's more specific `onTileRendering` anchor is tried first,
  // so a tiling #185 is dropped before this fallback is reached). Catches
  // non-tiling third-party #185s — e.g. the ProseMirror/TipTap-based editor
  // library's re-render loop fired by its document-state race (see
  // `isDocumentStateNotFoundNoise`): the three Better Stack patterns
  // `223d7d7e…` / `51b14963…` / `cd68e360…`, all from the same Safari 26.5
  // session as the doc-state race, NO `onTileRendering` frame, all UNCAUGHT.
  // Requires the #185 message AND TWO negative guards: NO resolved
  // first-party `apps/web/src/…` frame (a real first-party setState loop
  // de-minifies to `apps/web/src/…` and is preserved), AND the event is
  // UNCAUGHT (mechanism is a global/BrowserApiErrors auto-handler with
  // `handled:false` — a CAUGHT #185 that reached a React error boundary may
  // be actionable and keeps reporting). This matcher does NOT replace or
  // subsume the tiling matcher. See `isThirdPartyReactUpdateDepthNoise`.
  if (isThirdPartyReactUpdateDepthNoise({ message, mechanism, handled, frames })) {
    return true;
  }

  // Firefox-specific React scheduler re-entrancy noise — `Minified React error
  // #327;` (`Should not already be working.`), thrown from React's own
  // production reconciler chunk when the scheduler re-enters during the commit
  // phase. A well-known Firefox-specific quirk (react-router#10314 / react#17355
  // / react#29908) that does NOT reproduce on Chromium/WebKit. Requires the
  // canonical `#327;` message AND a NEGATIVE guard: a resolved first-party
  // `apps/web/src/…` frame means our own code is the re-entrant culprit (a real
  // `flushSync` inside render or sync `setState` during commit) → actionable, so
  // the event keeps reporting. Only React-internal minified-chunk captures with
  // no first-party frame are dropped. See
  // `isFirefoxReactSchedulerReentryNoise`.
  if (isFirefoxReactSchedulerReentryNoise({ message, frames })) {
    return true;
  }

  // Sentry 10.x bare-`undefined` non-Error promise rejection noise — a promise
  // rejected with the primitive `undefined` (not an Error), captured by
  // Sentry's GlobalHandlers `onunhandledrejection` integration as the
  // synthetic "Non-Error promise rejection captured with value: undefined"
  // message with NO stacktrace frames. A fire-and-forget `.then()` or a
  // third-party script (analytics / cookie banner / tag manager) on the
  // marketing site whose promise rejected with bare `undefined`; never
  // first-party app code. Requires the canonical message AND NEGATIVE guards:
  // any resolved first-party `apps/web/src/…` frame OR any resolvable frame
  // location → keep reporting (a real first-party `Promise.reject(undefined)`
  // we can attribute should still surface). The production noise pattern has
  // NO frames at all; only the frameless capture is dropped. See
  // `isNonErrorUndefinedRejectionNoise`. NOT in `ignoreErrors` (no frame
  // context there).
  if (isNonErrorUndefinedRejectionNoise({ message, frames })) {
    return true;
  }

  // Browser-internal DOM/binding `OperationError: Instance dropped in
  // popErrorScope` noise — `popErrorScope` is part of the WebIDL/internal
  // error-scope machinery (DOMQueuingStrategy, ResizeObserver,
  // IntersectionObserver, media streams, GPU, …), NOT a first-party API. Some
  // browser code paths surface a frameless `OperationError` with this exact
  // message as an uncaught global `onunhandledrejection`; never first-party
  // app code. Requires the EXACT message AND NEGATIVE guards: any resolved
  // first-party `apps/web/src/…` frame OR any resolvable frame location → keep
  // reporting (a real first-party `OperationError` rejection we can attribute
  // should still surface). The production noise pattern has NO frames at all;
  // only the frameless capture is dropped. See
  // `isOperationErrorPopErrorScopeNoise`. NOT in `ignoreErrors` (no frame
  // context there).
  if (isOperationErrorPopErrorScopeNoise({ message, frames })) {
    return true;
  }

  // Supabase gotrue `TOKEN_EXPIRED` auth-session rejection noise — a Supabase
  // auth session JWT expired mid-flight (during a page load after a Google
  // OAuth redirect, or during a stale session transition), and a fire-and-
  // forget `.then()` on a Supabase auth call rejected with the plain gotrue
  // error object `{ code: 400, message: "TOKEN_EXPIRED", status:
  // "INVALID_ARGUMENT" }`. Sentry's GlobalHandlers `onunhandledrejection`
  // integration serializes the plain object's enumerable keys into
  // `extra.__serialized__` and sets the exception value to the synthetic
  // "Object captured as promise rejection with keys: code, message, status"
  // with NO stacktrace frames. Requires the EXACT message (with the specific
  // `code, message, status` key set — distinct from the wallet-extension
  // `code, message, stack` key set matched by `isExtensionRejectedObjectNoise`)
  // AND NEGATIVE guards: any resolved first-party `apps/web/src/…` frame OR
  // any resolvable frame location → keep reporting (a real first-party
  // `Promise.reject({ code, message, status })` we can attribute should still
  // surface). The production noise pattern has NO frames at all; only the
  // frameless capture is dropped. See `isSupabaseTokenExpiredNoise`. NOT in
  // `ignoreErrors` (no frame context there).
  if (isSupabaseTokenExpiredNoise({ message, frames })) {
    return true;
  }

  // Supabase gotrue OTP-expired-link `Object Not Found Matching Id:…,
  // MethodName:update, ParamCount:…` non-Error promise rejection noise — a
  // user landed on an expired/invalid OTP email link
  // (`/#error=access_denied&error_code=otp_expired`), and the Supabase auth
  // client's session-update from the expired OTP token rejected with a bare
  // string `Object Not Found Matching Id:<n>, MethodName:update,
  // ParamCount:<n>` (gotrue's "no row found" wording; the `<n>` integers
  // vary per call). Because the rejected value is a bare string (NOT an
  // Error), Sentry 10.x's GlobalHandlers `onunhandledrejection` integration
  // cannot extract a stack and synthesizes the canonical "Non-Error promise
  // rejection captured with value: Object Not Found Matching Id:2,
  // MethodName:update, ParamCount:4" message with NO stacktrace frames.
  // Requires the canonical prefix (the suffix varies per gotrue call) AND
  // NEGATIVE guards: any resolved first-party `apps/web/src/…` frame OR any
  // resolvable frame location → keep reporting (a real first-party
  // bare-string `Promise.reject('Object Not Found Matching…')` we can
  // attribute should still surface). The production noise pattern has NO
  // frames at all; only the frameless capture is dropped. Sibling of
  // `isNonErrorUndefinedRejectionNoise` (PR #5200) and
  // `isSupabaseTokenExpiredNoise`. See
  // `isNonErrorObjectNotFoundRejectionNoise`. NOT in `ignoreErrors` (no
  // frame context there).
  if (isNonErrorObjectNotFoundRejectionNoise({ message, frames })) {
    return true;
  }

  // Bare lowercase `network error` rejection noise — the canonical Axios / XHR
  // transport-abort message (lowercase; distinct from Axios's capitalized
  // `Network Error` wrapper, which is a different surface and is NOT matched),
  // captured as an uncaught global `onunhandledrejection` with NO resolvable
  // stack frames. A fire-and-forget `.then()` or a third-party script on a
  // degraded network (the same session hit the 25s-deadline + audit 503s)
  // whose promise rejected with the bare transport-abort string; never
  // attributable first-party app code. Requires the EXACT bare message AND
  // NEGATIVE guards: any resolved first-party `apps/web/src/…` frame OR any
  // resolvable frame location → keep reporting (a real first-party
  // `new Error('network error')` we can attribute should still surface). The
  // production noise pattern has NO frames at all; only the frameless capture
  // is dropped. See `isFramelessNetworkErrorNoise`. NOT in `ignoreErrors` (no
  // frame context there).
  if (isFramelessNetworkErrorNoise({ message, frames })) {
    return true;
  }

  // Transient WebSocket / SSE transport-close noise — a client-side
  // websocket/SSE library threw the canonical `Connection closed.` message when
  // the server closed a background realtime connection on `/dashboard` during a
  // deploy / idle-timeout recycle / session end / load-balancer upstream
  // recycle. The connection closing is EXPECTED, not a product bug; sibling of
  // the transient-transport class (#4609 gateway retry). Requires the EXACT
  // message (case-sensitive, WITH the trailing period — the library's canonical
  // close string) and a NEGATIVE guard: any resolved first-party
  // `apps/web/src/…` frame → keep reporting (a real first-party
  // `throw new Error('Connection closed.')` regression de-minifies to
  // `apps/web/src/…` and must not be hidden). The prod event carries only a
  // minified `66499` chunk frame, so the negative guard does not fire for it.
  // A frameless capture with this exact message still classifies as noise.
  // This codifies the historical skip-list decision for `6c28b5b4…`-class
  // patterns into a real, tested matcher. NOT in `ignoreErrors` (no frame
  // context there). See `isConnectionClosedNoise`.
  if (isConnectionClosedNoise({ message, frames })) {
    return true;
  }

  // Transient WebSocket `postMessage` `Failed to send message` transport
  // noise — a co-worker session page's `ws.send(...)` rejected with the
  // canonical WebSocket `InvalidStateError` message when the sandbox tore
  // the connection down mid-flight (deploy / recycle / park / network
  // blip). Sibling of `isConnectionClosedNoise` (the `Connection closed.`
  // transport-close class) but a DIFFERENT throw (a `ws.send` rejection on
  // an already-closed socket). The prod event is `handled:true`
  // (mechanism `generic` — caught by an error boundary, NOT an uncaught
  // global rejection), so a first-party sender IS actionable — the
  // negative guard preserves any resolved first-party `apps/web/src/…`
  // frame. The prod event carries only a minified `_next/static/immutable/
  // chunks/…` frame, so the negative guard does not fire for it. NOT in
  // `ignoreErrors` (no frame context there). See
  // `isFailedToSendMessageNoise` and Better Stack pattern `824577dd…`.
  if (isFailedToSendMessageNoise({ message, frames })) {
    return true;
  }

  // Third-party editor-library (ProseMirror/TipTap-based) document-state
  // race noise — the library's own internal `getDocumentStateOrThrow` /
  // `getDocumentState` helpers threw
  // `<Interaction|Selection> state not found for document: <docId>` when the
  // editor was unmounted / the document closed while an async interaction or
  // selection was still in flight (a race in the library's async interaction
  // handling, triggered by WebKit's async timing). The throw is in the
  // library's minified `17631`/`13jg6` chunks, never first-party. Requires the
  // canonical message prefix AND a NEGATIVE guard: any resolved first-party
  // `apps/web/src/…` frame → keep reporting (a real first-party state-lookup
  // regression de-minifies to `apps/web/src/…` and must not be hidden). The
  // prod events (Better Stack `6d6fa794…` 28 occ + `a954c7e7…` 2 occ, same
  // Safari 26.5 session) carry only minified library chunk frames, so the
  // negative guard does not fire for them. NOT in `ignoreErrors` (no frame
  // context there). See `isDocumentStateNotFoundNoise`.
  if (isDocumentStateNotFoundNoise({ message, frames })) {
    return true;
  }

  // Bot / automation-framework / scraper `Cannot redefine property: webdriver`
  // noise — an injected anti-detection script attempts
  // `Object.defineProperty(navigator, 'webdriver', …)` to hide its automation
  // footprint, and Chrome throws a `TypeError` because `navigator.webdriver`
  // is non-configurable in that build. The throw is in the injected
  // automation script, never first-party code. Requires the EXACT message AND
  // a NEGATIVE guard: a resolved first-party `apps/web/src/…` frame means our
  // own code called `defineProperty` on a non-configurable property → a real
  // first-party regression; keep reporting. The production event carries only
  // `<anonymous>` frames, so the negative guard does NOT fire for it. A
  // frameless capture with this exact message still classifies as noise (the
  // `webdriver` property name is the specific anchor). NOT in `ignoreErrors`
  // (no frame context there). See `isRedefineWebdriverNoise` and Better Stack
  // pattern `ee14e84d…`.
  if (isRedefineWebdriverNoise({ message, frames })) {
    return true;
  }

  // Transient fetch-abort `signal timed out` noise — the native `TimeoutError`
  // raised by `AbortSignal.timeout()` when a client-side fetch exceeds its 30s
  // deadline. The SDK's `makeRequest` aborts on its 30s deadline and the abort
  // surfaces as `TimeoutError: signal timed out` in the frontend's
  // `onunhandledrejection`; it reaches Sentry through a fire-and-forget path
  // that bypasses `handleApiError`'s timeout guard. The API already filters
  // its OWN timeout wording (`The operation timed out.`, #4709), but the
  // frontend's `signal timed out` wording is NOT covered. A transient
  // network/timeout error, not a code bug. Requires the EXACT message AND a
  // NEGATIVE guard: a resolved first-party `apps/web/src/…` frame means our
  // own code threw `signal timed out` → a real first-party regression; keep
  // reporting. The production event has NO frames at all, so the negative
  // guard does NOT fire for it. A frameless capture with this exact message
  // classifies as noise. Sibling of `isClientRequestTimeoutMessage` (the SDK's
  // typed `Request timed out after <N>s:` wording). NOT in `ignoreErrors` (no
  // frame context there). See `isSignalTimeoutNoise` and Better Stack pattern
  // `73e683c3…`.
  if (isSignalTimeoutNoise({ message, frames })) {
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
  extra?: unknown;
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
