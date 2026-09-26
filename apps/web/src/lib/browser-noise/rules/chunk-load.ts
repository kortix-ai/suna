import type { NoiseRule } from '../evidence';
import { isBrowserBundleSource, isFirstPartyResolvedSource, normalizeString } from '../evidence';

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
const STALE_WEBPACK_RUNTIME_CALL_MESSAGE = "Cannot read properties of undefined (reading 'call')";

function isWebpackRuntimeChunkFilename(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return (
    /^app:\/\/\/_next\/static\/chunks\/webpack-[^/]*\.js/.test(normalized) ||
    /^https?:\/\/[^/]+\/_next\/static\/chunks\/webpack-[^/]*\.js/.test(normalized)
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
  return normalized === '' || normalized === SENTRY_NO_ERROR_MESSAGE_PLACEHOLDER;
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
  if (!frames.every((frame) => isBrowserBundleSource(frame?.filename))) {
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

export const CHUNK_LOAD_RULES: readonly NoiseRule[] = [
  { id: 'stale-webpack-runtime', appliesTo: 'sentry', match: isStaleWebpackRuntimeCallNoise },
  {
    id: 'empty-message-bundle-chunk',
    appliesTo: 'sentry',
    match: isEmptyMessageUnresolvedBrowserChunkNoise,
  },
];
