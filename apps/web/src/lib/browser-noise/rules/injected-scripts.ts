import type { NoiseRule } from '../evidence';
import {
  isFirstPartyResolvedSource,
  normalizeString,
  sourcesOf,
  stripErrorWrappers,
} from '../evidence';

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
  const sources = sourcesOf(input);
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
// `https://kortix.com/projects/<project_id>` (project page), browser Chrome on
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
const REDEFINE_WALLET_PROVIDER_NOISE_MESSAGE =
  /^Cannot redefine property: (?:ethereum|solana|web3|tronWeb)$/;

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
  const sources = sourcesOf(input);
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

/** Keep first-party defineProperty failures visible, including wallet globals. */
export function isRedefineInjectedWalletNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const stripped = stripErrorWrappers(normalizeString(input.message));
  return (
    REDEFINE_WALLET_PROVIDER_NOISE_MESSAGE.test(stripped) &&
    !sourcesOf(input).some(isFirstPartyResolvedSource)
  );
}

/** Vercel toolbar frames have a reserved source path outside app bundles. */
export function isVercelLiveFeedbackNoise(input: {
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  const sources = sourcesOf(input);
  const isFeedbackFrame = (source: unknown): boolean =>
    /^app:\/\/\/_next-live\/feedback\//.test(normalizeString(source)) ||
    /^https?:\/\/[^/]+\/_next-live\/feedback\//.test(normalizeString(source));
  return sources.some(isFeedbackFrame) && !sources.some(isFirstPartyResolvedSource);
}

export const INJECTED_SCRIPT_RULES: readonly NoiseRule[] = [
  { id: 'onetrust-json-parse', appliesTo: 'both', match: isOneTrustJsonParseNoise },
  { id: 'redefine-webdriver', appliesTo: 'both', match: isRedefineWebdriverNoise },
  { id: 'redefine-wallet-provider', appliesTo: 'both', match: isRedefineInjectedWalletNoise },
  { id: 'vercel-live-feedback', appliesTo: 'both', match: isVercelLiveFeedbackNoise },
];
