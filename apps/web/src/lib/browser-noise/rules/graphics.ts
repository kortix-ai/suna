import type { NoiseRule } from '../evidence';
import {
  isFirstPartyResolvedSource,
  normalizeString,
  sourcesOf,
  stripErrorWrappers,
} from '../evidence';

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
  // `https://kortix.com/projects/<project_id>` (project page), browser Firefox
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
  return PAPER_SHADER_NULL_CONTEXT_NOISE_PATTERNS.some((pattern) => stripped.includes(pattern));
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
  const stripped = stripErrorWrappers(normalizeString(input.message)).replace(/^Error: /, '');
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

// Paper Shaders (`@paper-design/shaders-react`) image-uniform load-race throw —
// a THIRD sibling of the two Paper Shaders classes above, and like the
// WebGL-unsupported one it is the library's OWN deliberate `throw`, not a
// JS-engine TypeError.
//
// Every Paper Shaders effect that dithers or grains its output uploads a small
// bundled noise bitmap to the `u_noiseTexture` sampler uniform. The library
// guards that upload with an `img.complete` assertion and throws
// `Paper Shaders: image for uniform u_noiseTexture must be fully loaded` when
// the shader mount reaches the upload before the browser finished decoding the
// bitmap. That is a race inside the library between its own image load and its
// own rAF-driven mount — first-party code neither supplies this image nor names
// this uniform (`rg "u_noiseTexture|noiseTexture" apps/web/src` matches
// nothing). It is transient: the same page renders the shader normally on the
// next paint once the bitmap is decoded, which is why it appears as scattered
// single occurrences across visitors rather than a deterministic route failure.
// Slow connections, throttled background tabs and cold caches all widen the
// window. Better Stack, Kortix Frontend prod: 10+ occurrences, `Error`, call
// site `?` in chunk `app:///_next/static/immutable/chunks/2-qxa2k33wllw.js`
// (Paper Shaders library) — no first-party frame.
//
// The throw escapes `<ShaderSafe>` for the same reason the null-context class
// does: it fires inside an async mount callback, and `getDerivedStateFromError`
// only catches render-phase throws. `supportsWebGL2()` cannot prevent it
// either — WebGL2 IS supported here; only the bitmap is late.
//
// Same message-only contract as its siblings: the `Paper Shaders:` prefix is
// the library's canonical marker, never emitted by first-party app code, and
// the `u_noiseTexture` uniform name pins the single library call site. The
// first-party negative guard is kept so a hypothetical first-party throw
// carrying this exact string still reports. NOT in `ignoreErrors`: that gate
// has no frame context, so the first-party negative guard could not run there.
const PAPER_SHADER_IMAGE_UNIFORM_NOISE_MESSAGE =
  'Paper Shaders: image for uniform u_noiseTexture must be fully loaded';

/**
 * Whether a Sentry / window.onerror event is the Paper Shaders
 * (`@paper-design/shaders-react`) `u_noiseTexture` image-uniform load-race
 * throw. See {@link PAPER_SHADER_IMAGE_UNIFORM_NOISE_MESSAGE} for the full
 * rationale.
 *
 * Requires the EXACT library message AND a NEGATIVE guard: any frame that
 * resolves to a de-minified first-party `apps/web/src/…` source keeps
 * reporting. The production shape carries only minified library chunk frames,
 * so the guard does not fire for it; a frameless capture with this exact
 * message still classifies as noise.
 */
export function isPaperShaderImageUniformNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): boolean {
  // `stripErrorWrappers` does not strip a bare `Error: ` prefix (its
  // `[A-Za-z]+Error:` regex needs a leading word), and this class is thrown as
  // a plain `Error`, so strip that form explicitly — same as
  // `isPaperShaderWebGLUnsupportedNoise`.
  const stripped = stripErrorWrappers(normalizeString(input.message)).replace(/^Error: /, '');
  if (stripped !== PAPER_SHADER_IMAGE_UNIFORM_NOISE_MESSAGE) {
    return false;
  }
  const frames = input.frames ?? [];
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
  const sources = sourcesOf(input);
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

export const GRAPHICS_RULES: readonly NoiseRule[] = [
  {
    id: 'paper-shaders-null-context',
    appliesTo: 'both',
    match: ({ message }) => isPaperShaderNullContextNoise(message),
  },
  {
    id: 'paper-shaders-webgl-unsupported',
    appliesTo: 'sentry',
    match: isPaperShaderWebGLUnsupportedNoise,
  },
  { id: 'paper-shaders-image-uniform', appliesTo: 'sentry', match: isPaperShaderImageUniformNoise },
  { id: 'canvas-image-data-oom', appliesTo: 'both', match: isCanvasImageDataOOMNoise },
];
