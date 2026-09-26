import type { NoiseRule } from '../evidence';
import {
  isFirstPartyResolvedSource,
  normalizeString,
  sourcesOf,
  stripErrorWrappers,
} from '../evidence';

const EXTENSION_PROTOCOL_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-extension://',
  'safari-web-extension://',
  'extension://',
] as const;

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
  // Browser-extension bundle injected as `app:///executors/<chunkId>.js` — the
  // same synthetic `app:///` empty-host origin shape as the sources above, with
  // a webpack-style numeric chunk file under an `executors/` directory. Its own
  // code dereferences an undefined object and throws
  // `TypeError: Cannot read properties of undefined (reading 'M_ID')` from a
  // minified extension function (`Y`), which Sentry captures and ships to
  // Better Stack (Kortix Frontend prod, `app:///executors/200.js`, 10+
  // occurrences). `M_ID` is not a first-party identifier and there is no
  // `executors/` path in this app: first-party bundles are always
  // `app:///_next/…` and de-minify to `apps/web/src/…`, neither of which this
  // pattern matches. The chunk id varies with the extension's build, so the
  // stable anchor is the `executors/<digits>.js` shape, not one file name.
  /^app:\/\/\/executors\/\d+\.js$/,
] as const;

export function isExtensionSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return EXTENSION_PROTOCOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isInjectedAppSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return INJECTED_APP_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

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
  const sources = sourcesOf(input);
  return sources.some(isUserscriptManagerInjectedSource);
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
  const sources = sourcesOf(input);
  return sources.some(
    (filename) => isTronLinkInjectedSource(filename) || isExtensionSource(filename),
  );
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
  const sources = sourcesOf(input);
  return sources.some(
    (filename) => isInpageWalletInjectedSource(filename) || isExtensionSource(filename),
  );
}

// Wallet-extension injected-`inpage.js` "No error message" noise — a SIBLING
// of the stream EventEmitter noise class above (`isInpageWalletStreamNoise`),
// but a DIFFERENT throw: the wallet extension's `onGlobalMessage` →
// `runIfPresent` → `run` handlers in `app:///inpage.js` throw a value that has
// no `.message` property, so Sentry SDK 10.x writes the `"No error message"`
// placeholder. The error propagates through the React reconciler and into the
// `global-error` boundary, which Sentry's `onerror` handler then captures. The
// stream-noise matcher does NOT catch this because its message markers
// (`addListener`/`emit`) are absent — the message is the placeholder string
// `"No error message"` instead. The `isEmptyMessageUnresolvedBrowserChunkNoise`
// matcher also does NOT catch it because the `app:///inpage.js` frames are NOT
// browser-bundle sources (its negative guard #2 requires ALL frames to be
// browser bundle sources, and the extension frames violate that).
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
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list —
// that gate has no frame context, so a bare `"No error message"` string match
// there would swallow a real first-party error with no message that has no
// inpage.js frame; the frame-aware `beforeSend` hook (which calls
// `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
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
 * rather than swallow a possible app bug). See the comment above for the full
 * rationale and the production pattern `61949432…`.
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
  const sources = sourcesOf(input);
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
const SYNTHETIC_OBJECT_REJECTION_PATTERN = /^Object captured as promise rejection with keys:/;

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
    typeof stack === 'string' &&
    EXTENSION_PROTOCOL_PREFIXES.some((prefix) => stack.includes(prefix))
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
  const sources = sourcesOf(input);
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
  const sources = sourcesOf(input);
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

export const EXTENSION_RULES: readonly NoiseRule[] = [
  {
    id: 'injected-app-source',
    appliesTo: 'both',
    match: (evidence) => sourcesOf(evidence).some(isInjectedAppSource),
  },
  { id: 'userscript-manager', appliesTo: 'both', match: isUserscriptManagerNoise },
  {
    id: 'injected-script-send-message',
    appliesTo: 'both',
    match: isInjectedScriptSendMessageNoise,
  },
  { id: 'captcha-interceptor', appliesTo: 'both', match: isCaptchaInterceptorNoise },
  { id: 'tronlink-proxy', appliesTo: 'both', match: isTronLinkProxyNoise },
  { id: 'inpage-wallet-stream', appliesTo: 'both', match: isInpageWalletStreamNoise },
  { id: 'inpage-wallet-no-message', appliesTo: 'sentry', match: isInpageJsNoErrorMessageNoise },
  { id: 'extension-rejected-object', appliesTo: 'sentry', match: isExtensionRejectedObjectNoise },
  {
    // The runtime gate receives the raw rejected object as `reason`/`error`
    // (whose `message` is the provider's own, NOT Sentry's synthetic "Object
    // captured as promise rejection …" wording), so it anchors on the rejected
    // value's own `stack`. See `rejectedObjectHasExtensionStack`.
    id: 'extension-rejected-value',
    appliesTo: 'runtime',
    match: ({ reason, error }) =>
      rejectedObjectHasExtensionStack(reason) || rejectedObjectHasExtensionStack(error),
  },
  {
    id: 'extension-frame',
    appliesTo: 'sentry',
    match: ({ frames }) => frames.some((frame) => isExtensionSource(frame?.filename)),
  },
  {
    id: 'extension-runtime-send-message',
    appliesTo: 'runtime',
    match: ({ message, filename }) =>
      isExtensionSource(filename) && normalizeString(message).includes('runtime.sendMessage'),
  },
  {
    id: 'auth-runtime-send-message',
    appliesTo: 'sentry',
    match: ({ message, requestUrl }) =>
      requestUrl.includes('/auth') && normalizeString(message).includes('runtime.sendMessage'),
  },
];
