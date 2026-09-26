import type { NoiseRule } from '../evidence';
import {
  isFirstPartyResolvedSource,
  isResolvableFrameSource,
  normalizeString,
  sourcesOf,
  stripErrorWrappers,
} from '../evidence';

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
// different message on modern browsers (which all support lookbehind). The
// de-minified frame points at our own chunk, so this is matched by message,
// not by source.
const OLD_WEBKIT_REGEX_NOISE_PATTERNS = ['invalid group specifier name'] as const;

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
// onunhandledrejection, Sentry exception) classify consistently. Deliberately
// NOT added to `sentry.client.config.ts`'s `ignoreErrors` list — that gate has
// no frame context, so a bare-string match there would swallow real app
// SyntaxErrors; the frame-aware `beforeSend` hook is the only safe gate.
const OLD_BROWSER_SYNTAX_PARSE_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Unexpected token\b/,
  /^Invalid or unexpected token$/,
  /^Cannot use import statement outside a module$/,
];

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
    normalized.includes('/_next/static/chunks/') || /[?&]dpl=dpl_[A-Za-z0-9]+/.test(normalized)
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
  const sources = sourcesOf(input);
  return sources.some((filename) => isMinifiedChunkSource(filename));
}

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
  const sources = sourcesOf(input);
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
const STACK_OVERFLOW_NOISE_PATTERN = /^Maximum call stack size exceeded\.?$/;

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
  const sources = sourcesOf(input);
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

// Safari third-party-script "undefined variable" ReferenceError noise — the
// `Can't find variable: <Name>` wording is Safari/JavaScriptCore's canonical
// ReferenceError for a variable reference that resolved to an undeclared
// binding (Chrome/V8 says `<Name> is not defined`). When a THIRD-PARTY script
// loaded on the marketing homepage (a charting/finance library such as
// TradingView / lightweight-charts, or any vendor script that defines a
// top-level constant like `EmptyRanges`) fails to load or initialize on iOS
// Safari — a network abort, a parse failure, a CSP block, a script-load race
// — the referencing code dereferences the now-undefined global and Safari's
// `window.onerror` captures a FRAMELESS `ReferenceError`: the engine could
// not produce a stack because the throw originated in script text that never
// evaluated, so `call_site_file` is the literal `"undefined"` placeholder and
// there are NO stack frames. The variable name (`EmptyRanges`, …) belongs to
// the third-party script, NEVER to first-party `apps/web/src/…` code (grep
// confirms `EmptyRanges` is absent from the codebase).
//
// Better Stack pattern
// 304f7345eea41d488225ebf2dd238fa05ca073187fd0e2ffc61071ac99f40408
// (Kortix Frontend prod, application_id 2346967): `ReferenceError`, message
// `Can't find variable: EmptyRanges`, 5 occurrences / 0 identified users,
// first 2026-08-13 06:24:03 UTC, release
// `1f8409e2bedf441343eb12086a2131ff69397c37` (v0.12.8 prod),
// call_site_function `?`, call_site_file `undefined` (the literal
// placeholder — NO resolvable source location), request URL
// `https://kortix.com/` (marketing homepage), browser iPhone iOS 18.7 Safari
// (Safari 26), mechanism `auto.browser.global_handlers.onerror` (UNCAUGHT
// global `onerror`, `handled:false` — never reached a React error
// boundary). Frames: `undefined` — no stack frames at all.
//
// Same family as the prior frameless Safari / browser-internal noise matchers
// — `isUnresolvableStackOverflowNoise` (Safari frameless `onerror` stack
// overflow), `isNonErrorUndefinedRejectionNoise` (PR #5200, pattern
// `5cfc90e5…`), and `isOperationErrorPopErrorScopeNoise` (PR #5237, pattern
// `5e1aca20…`) — a frameless global-handler capture dropped by a precise
// message matcher with two negative guards preserving any first-party or
// resolvable frame.
//
// `Can't find variable: <Name>` is Safari's GENERIC ReferenceError wording —
// a REAL first-party `ReferenceError` (e.g. a typo referencing an undeclared
// variable in our own code, `Can't find variable: myHelper`) would surface
// with the SAME wording, so the matcher requires BOTH:
//   1. The Safari ReferenceError PREFIX `/^Can't find variable: /`
//      (case-sensitive). The variable name (`EmptyRanges`, `WebAssembly`, …)
//      varies per third-party script, so a prefix (not exact) match is
//      required. Chrome/V8's `<Name> is not defined` wording is a DIFFERENT
//      surface and is deliberately NOT matched, so a Chromium first-party
//      ReferenceError keeps reporting.
//   2. The FRAMELESS shape as a positive guard: no resolvable frame location
//      at all (every frame's `filename` is empty or the literal `"undefined"`
//      placeholder, and the window.onerror `filename` is empty/`undefined`)
//      — mirroring `isNonErrorUndefinedRejectionNoise` /
//      `isOperationErrorPopErrorScopeNoise` / `isUnresolvableStackOverflowNoise`.
// Plus two negative guards: (a) any resolved first-party `apps/web/src/…`
// frame → keep reporting (our own ReferenceError with a stack is preserved —
// a real first-party Safari `ReferenceError` de-minifies to `apps/web/src/…`);
// (b) ANY resolvable frame location (real chunk/URL/named file) → keep
// reporting (a reference error with a stack frame is from traceable code,
// first-party OR a third-party script that DID load and threw a resolvable
// ReferenceError). Only the frameless capture (the production noise pattern:
// a third-party script that failed to load entirely, leaving no stack) is
// dropped. Deliberately NOT added to `sentry.client.config.ts`'s
// `ignoreErrors` list — that gate has no frame context, so a bare-prefix
// match there would swallow a real first-party Safari ReferenceError the
// negative guards exist to preserve; the frame-aware `beforeSend` hook
// (which calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate.
const UNDEFINED_VARIABLE_NOISE_PATTERN = /^Can't find variable: /;

/**
 * Whether a Sentry / window.onerror event is the Safari third-party-script
 * "undefined variable" ReferenceError noise class: a `Can't find variable:
 * <Name>` `ReferenceError` (Safari/JavaScriptCore's canonical wording for an
 * undeclared variable reference — Chrome/V8 says `<Name> is not defined`)
 * captured by the global `onerror` handler with NO resolvable source
 * location (the throw originated in a third-party script that failed to load,
 * so the engine produced no stack and `call_site_file` is the literal
 * `"undefined"` placeholder). The variable name belongs to the third-party
 * script (e.g. `EmptyRanges` from a charting/finance library), never to
 * first-party `apps/web/src/…` code. Requires BOTH the Safari ReferenceError
 * prefix AND the frameless shape (positive guard), plus two negative guards:
 * any resolved first-party `apps/web/src/…` frame → keep reporting (our own
 * ReferenceError with a stack is preserved); any resolvable frame location →
 * keep reporting (a reference error with a stack frame is from traceable
 * code). Only the frameless capture is dropped. See
 * `UNDEFINED_VARIABLE_NOISE_PATTERN` for the full rationale and Better Stack
 * pattern `304f7345…`.
 */
export function isUndefinedVariableThirdPartyNoise(input: {
  message?: unknown;
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  if (!UNDEFINED_VARIABLE_NOISE_PATTERN.test(stripErrorWrappers(normalizeString(input.message)))) {
    return false;
  }
  const sources = sourcesOf(input);
  // Negative guard #1: a resolved first-party `apps/web/src/…` frame means our
  // own code referenced an undeclared variable → a real first-party
  // ReferenceError with a stack; keep reporting so the call site can be found
  // + fixed. A real first-party Safari `ReferenceError` de-minifies to
  // `apps/web/src/…` and is never hidden.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  // Negative guard #2: any resolvable source location (real chunk/URL/named
  // file) → an attributable ReferenceError with a real stack (first-party OR a
  // third-party script that DID load and threw a resolvable ReferenceError);
  // keep reporting. Only the frameless capture (the production noise pattern:
  // a third-party script that failed to load entirely, leaving no stack)
  // remains → drop it.
  if (sources.some(isResolvableFrameSource)) {
    return false;
  }
  return true;
}

export const OLD_BROWSER_RULES: readonly NoiseRule[] = [
  {
    id: 'old-webkit-regex',
    appliesTo: 'both',
    match: ({ message }) => isOldWebkitRegexNoiseMessage(message),
  },
  { id: 'old-browser-syntax', appliesTo: 'both', match: isOldBrowserSyntaxParseError },
  { id: 'old-browser-dom-null-deref', appliesTo: 'both', match: isOldBrowserDomNullDerefNoise },
  { id: 'frameless-stack-overflow', appliesTo: 'both', match: isUnresolvableStackOverflowNoise },
  {
    id: 'frameless-undefined-variable',
    appliesTo: 'both',
    match: isUndefinedVariableThirdPartyNoise,
  },
];
