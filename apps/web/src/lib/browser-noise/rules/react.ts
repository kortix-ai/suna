import type { NoiseRule } from '../evidence';
import {
  containsKnownPattern,
  isBrowserBundleSource,
  isFirstPartyResolvedSource,
  normalizeString,
  sourcesOf,
  stripErrorWrappers,
} from '../evidence';

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
  'The supplied node is incorrect or has an incorrect ancestor for this operation.',
] as const;

const KNOWN_HYDRATION_NOISE_MESSAGES = [
  'Minified React error #418',
  'Hydration failed because the server rendered',
] as const;

// React #185 = "Maximum update depth exceeded" — the canonical React
// infinite-setState-loop error. Shared by the `@embedpdf` tiling matcher
// (`pdf.ts`) and the broader third-party fallback below.
export const REACT_UPDATE_DEPTH_NOISE_PATTERN = /^Minified React error #185\b/;

export function isLikelyDomMutationNoise(message: unknown): boolean {
  const normalized = normalizeString(message);
  return (
    containsKnownPattern(normalized, KNOWN_DOM_MUTATION_NOISE_MESSAGES) ||
    containsKnownPattern(normalized, KNOWN_HYDRATION_NOISE_MESSAGES)
  );
}

// Broader third-party-library React #185 "Maximum update depth exceeded"
// fallback noise matcher. The `isEmbedPdfTilingReactUpdateDepthNoise`
// matcher (`pdf.ts`) anchors on the SPECIFIC `@embedpdf/plugin-tiling`
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
// `<session_id>`, SAME release
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
// #185 message (`REACT_UPDATE_DEPTH_NOISE_PATTERN`, defined above)
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
// IMPORTANT: this is a FALLBACK next to `isEmbedPdfTilingReactUpdateDepthNoise`.
// It does NOT replace or subsume the tiling matcher: a tiling #185 with an
// `onTileRendering` frame is dropped by the tiling rule whatever this one
// says. This fallback only catches the non-tiling third-party #185 class
// (the editor re-render loop siblings here). Deliberately NOT
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
 * in `pdf.ts`). This is the BROADER FALLBACK for non-tiling third-party #185s —
 * e.g. the ProseMirror/TipTap-based editor library's re-render loop fired by
 * its document-state race (see `isDocumentStateNotFoundNoise`). Requires
 * the `Minified React error #185` message AND TWO negative guards: (1) NO
 * resolved first-party `apps/web/src/…` frame (a real first-party setState
 * loop de-minifies to `apps/web/src/…` and is preserved), and (2) the event
 * is UNCAUGHT — its mechanism is one of the global auto-handlers
 * (`onerror`/`onunhandledrejection`) or a `BrowserApiErrors` auto-wrapper
 * (`addEventListener`/`setTimeout`/`setInterval`/…) with `handled:false`. A
 * CAUGHT React #185 (reached a React error boundary, `handled:true`) may be
 * actionable and keeps reporting. It does NOT replace or subsume
 * `isEmbedPdfTilingReactUpdateDepthNoise`. See
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
//     `Interaction state not found for document: <doc_id>`,
//     call_site_function `getDocumentStateOrThrow`, call_site_file
//     `app:///_next/static/chunks/17631.2j-4o95.js`, 28 occurrences / 0
//     identified users, last 2026-08-05 04:40:45 UTC (POST-v0.12.3),
//     mechanism `auto.browser.browserapierrors.addEventListener` (UNCAUGHT,
//     `handled:false`), request URL
//     `https://kortix.com/projects/<project_id>/sessions/<session_id>` (session
//     page), Safari 26.5 on macOS (WebKit). Frames: `r @ 13jg6.ewllp.z.js` →
//     `v @ 17631.2j-4o95.js` → `getActiveMode @ 17631.2j-4o95.js` →
//     `getDocumentStateOrThrow @ 17631.2j-4o95.js` — NO first-party
//     `apps/web/src/…` frame.
//   - `a954c7e7553065986e8177c68b82ccf3c3d83d6eabb413700974b2a11f841fb7`:
//     `Error`, message
//     `Selection state not found for document: <doc_id>`
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
//   4. 28+2 occurrences from a SINGLE session (`<session_id>`) in a short window
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
  const sources = sourcesOf(input);
  // Negative guard: a resolved first-party `apps/web/src/…` frame means our
  // own code threw this state-lookup message → a real first-party regression;
  // keep reporting so the call site can be found + fixed.
  if (sources.some(isFirstPartyResolvedSource)) {
    return false;
  }
  return true;
}

export const REACT_RULES: readonly NoiseRule[] = [
  {
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
    id: 'dom-mutation',
    appliesTo: 'sentry',
    match: ({ message }) => isLikelyDomMutationNoise(message),
  },
  { id: 'third-party-update-depth', appliesTo: 'sentry', match: isThirdPartyReactUpdateDepthNoise },
  {
    id: 'firefox-scheduler-reentry',
    appliesTo: 'sentry',
    match: isFirefoxReactSchedulerReentryNoise,
  },
  { id: 'editor-document-state', appliesTo: 'both', match: isDocumentStateNotFoundNoise },
];
