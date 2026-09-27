import type { NoiseRule } from '../evidence';
import {
  isFirstPartyResolvedSource,
  isResolvableFrameSource,
  normalizeString,
  sourcesOf,
  stripErrorWrappers,
} from '../evidence';

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
    !ANDROID_WEBVIEW_NATIVE_BRIDGE_POSTMESSAGE_NOISE_MESSAGES.some((noise) => message === noise)
  ) {
    return false;
  }
  const sources = sourcesOf(input);
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
  if (!ANDROID_WEBVIEW_NATIVE_BRIDGE_POSTEVENT_NOISE_MESSAGES.some((noise) => message === noise)) {
    return false;
  }
  const sources = sourcesOf(input);
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
  if (
    sources.some(
      (filename) => normalizeString(filename) === ANDROID_WEBVIEW_BRIDGE_THROW_SITE_FRAME,
    )
  ) {
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
  const sources = sourcesOf(input);
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
  const hasInstrumentedSource = sources.some(
    (filename) => normalizeString(filename) === IOS_WEBVIEW_INSTRUMENTED_FRAME_SOURCE,
  );
  // Without the positive anchor (no `app:///` frame and no instrumentation
  // function) we cannot confirm the iOS WebView origin — keep reporting rather
  // than swallow a possible first-party `window.webkit.messageHandlers`
  // access. The prod event carries 3 `app:///` frames including the throwing
  // `sendDataToNative`, so the anchor matches.
  return hasInstrumentedFunction || hasInstrumentedSource;
}

export const WEBVIEW_RULES: readonly NoiseRule[] = [
  {
    id: 'android-webview-post-message',
    appliesTo: 'both',
    match: isAndroidWebViewNativeBridgePostMessageNoise,
  },
  {
    id: 'android-webview-post-event',
    appliesTo: 'both',
    match: isAndroidWebViewNativeBridgePostEventNoise,
  },
  { id: 'ios-webview-webkit-bridge', appliesTo: 'both', match: isIOSWebViewWebKitBridgeNoise },
];
