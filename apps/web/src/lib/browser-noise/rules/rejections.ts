import type { NoiseRule } from '../evidence';
import { isFirstPartyResolvedSource, isResolvableFrameSource, normalizeString } from '../evidence';

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
const OPERATION_ERROR_POP_ERROR_SCOPE_PATTERN = /^Instance dropped in popErrorScope$/;

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
// `https://kortix.com/projects/<project_id>` (second
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

export const REJECTION_RULES: readonly NoiseRule[] = [
  {
    id: 'non-error-undefined-rejection',
    appliesTo: 'sentry',
    match: isNonErrorUndefinedRejectionNoise,
  },
  { id: 'pop-error-scope', appliesTo: 'sentry', match: isOperationErrorPopErrorScopeNoise },
  { id: 'supabase-token-expired', appliesTo: 'sentry', match: isSupabaseTokenExpiredNoise },
  {
    id: 'non-error-object-not-found',
    appliesTo: 'sentry',
    match: isNonErrorObjectNotFoundRejectionNoise,
  },
];
