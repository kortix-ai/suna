import type { NoiseRule } from '../evidence';
import {
  containsKnownPattern,
  isFirstPartyResolvedSource,
  normalizeString,
  sourcesOf,
  stripErrorWrappers,
} from '../evidence';

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
  const sources = sourcesOf(input);
  // Negative guard: a resolved first-party frame means our own code is the
  // direct-access culprit — keep reporting so the call site can be fixed.
  return !sources.some(isFirstPartyResolvedSource);
}

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
  const sources = sourcesOf(input);
  // Negative guard: a resolved first-party frame means our own code threw this
  // SecurityError — actionable (a real first-party code regression), keep
  // reporting so the call site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
}

export const STORAGE_RULES: readonly NoiseRule[] = [
  {
    id: 'storage-null-access',
    appliesTo: 'both',
    match: ({ message }) => isStorageDisabledWebViewNoiseMessage(message),
  },
  { id: 'storage-security-error', appliesTo: 'both', match: isStorageSecurityErrorNoise },
  { id: 'safari-insecure-operation', appliesTo: 'both', match: isSafariGenericSecurityErrorNoise },
];
