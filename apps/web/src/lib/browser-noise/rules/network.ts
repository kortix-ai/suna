import type { NoiseRule } from '../evidence';
import {
  isFirstPartyResolvedSource,
  isResolvableFrameSource,
  normalizeString,
  sourcesOf,
  stripErrorWrappers,
} from '../evidence';

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
  const stripped = stripErrorWrappers(normalizeString(input.message)).replace(/^Error: /, '');
  if (!CONNECTION_CLOSED_NOISE_PATTERN.test(stripped)) {
    return false;
  }
  // Collect every source location — the window.onerror `filename` (runtime
  // gate) and any stacktrace frames (Sentry gate) — for the first-party
  // negative guard.
  const sources = sourcesOf(input);
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
// (`https://kortix.com/projects/<project_id>/sessions/<session_id>`), browser
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
  const stripped = stripErrorWrappers(normalizeString(input.message)).replace(/^Error: /, '');
  if (!FAILED_TO_SEND_MESSAGE_NOISE_PATTERN.test(stripped)) {
    return false;
  }
  // Collect every source location — the window.onerror `filename` (runtime
  // gate) and any stacktrace frames (Sentry gate) — for the first-party
  // negative guard.
  const sources = sourcesOf(input);
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
  const sources = sourcesOf(input);
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

export const NETWORK_RULES: readonly NoiseRule[] = [
  { id: 'connection-closed', appliesTo: 'both', match: isConnectionClosedNoise },
  { id: 'failed-to-send-message', appliesTo: 'both', match: isFailedToSendMessageNoise },
  { id: 'frameless-network-error', appliesTo: 'sentry', match: isFramelessNetworkErrorNoise },
  { id: 'signal-timeout', appliesTo: 'both', match: isSignalTimeoutNoise },
];
