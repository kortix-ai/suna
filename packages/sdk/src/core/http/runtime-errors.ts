

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error ?? '');
}

export function parseRuntimeErrorPayload(error: unknown): unknown {
  const raw = rawErrorMessage(error).trim();
  if (!raw) return null;

  const candidates = [
    raw,
    raw.replace(/^Failed to perform action:\s*/i, '').trim(),
  ];

  const objectStart = raw.indexOf('{');
  if (objectStart >= 0) candidates.push(raw.slice(objectStart));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }

  return null;
}

// Every readiness phrase the API can answer with while a sandbox (or the
// runtime inside it) is provisioning, resuming, or parked. Each line maps to a
// production site in apps/api:
//   - `sandbox not ready (status: X)` / bare `sandbox not ready`
//     → sandbox-proxy/routes/preview.ts (HTTP proxy + WebSocket resolver)
//   - `Sandbox is not running` → sandbox-proxy/routes/public-share.ts
//   - `Sandbox is not ready` → public-session-shares, shared/session-public-shares
//   - `sandbox_not_ready`, `sandbox_lifecycle_unavailable` → machine codes on
//     503 bodies from the sandbox proxy
// Deliberately NOT here: `sandbox port unreachable` — that is emitted only
// after the box reported active and the port still failed to answer, which is
// a genuine failure, not parking.
//   - `runtime_not_ready` (code), `sandbox runtime not ready` → the daemon's
//     own 503, `RUNTIME_NOT_READY_MARKERS` below
const SANDBOX_NOT_READY_PATTERNS: readonly RegExp[] = [
  /sandbox not ready/i,
  /sandbox is not (?:ready|running)/i,
  /\bsandbox_not_ready\b/,
  /\bsandbox_lifecycle_unavailable\b/,
];

/**
 * Every spelling of the daemon's 503 while the session runtime cannot take a
 * request, as lower-case substrings: the `code` a W6 daemon sends, then the
 * `error` text of a daemon without the code. For a host that needs a string
 * list (a telemetry ignore list); a predicate should call
 * `isRuntimeNotReadyResponse`.
 */
export const RUNTIME_NOT_READY_MARKERS = [
  'runtime_not_ready',
  'sandbox runtime not ready',
] as const;

// `\b` keeps the API's `runtime_not_ready_timeout` park reason out.
const RUNTIME_NOT_READY_PATTERN = /\bruntime_not_ready\b|sandbox runtime not ready/i;

/**
 * True when the daemon refused a request because the session runtime is not up
 * yet. The request was not forwarded: nothing reached the agent, and a retry is
 * safe. Narrower than `isSandboxNotReadyError`, which also covers a sandbox
 * that is stopped or parked.
 */
export function isRuntimeNotReadyResponse(error: unknown): boolean {
  return RUNTIME_NOT_READY_PATTERN.test(rawErrorMessage(error));
}

/**
 * True when an error means "the sandbox is still starting / parked", i.e. a
 * readiness state the control plane reports on purpose. A UI must render this
 * as a pending "waking up" state and keep polling — never as a terminal error.
 * Accepts an `Error`, the raw message string, or a JSON body containing one.
 */
export function isSandboxNotReadyError(error: unknown): boolean {
  const raw = rawErrorMessage(error);
  if (!raw) return false;
  return isRuntimeNotReadyResponse(raw) || SANDBOX_NOT_READY_PATTERNS.some((pattern) => pattern.test(raw));
}

// `getClient()` and the env and pty guards throw this wording for the ~1 s
// before a new or switched session's runtime URL is pinned.
const RUNTIME_URL_NOT_PINNED = /server url not ready|sandbox is still loading/i;

/**
 * True for every "the session runtime is still starting" error a render path
 * can meet: the runtime URL is not pinned yet, or the sandbox or its daemon
 * answered not-ready. All of them clear on their own, so a boundary retries
 * instead of showing a crash.
 */
export function isRuntimeStartingError(error: unknown): boolean {
  return RUNTIME_URL_NOT_PINNED.test(rawErrorMessage(error)) || isSandboxNotReadyError(error);
}

/**
 * A message read (or any runtime read) that failed because the sandbox is
 * still provisioning, resuming, or parked — the readiness state the control
 * plane reports ON PURPOSE (a 503 from the sandbox proxy, or a body carrying
 * one of `SANDBOX_NOT_READY_PATTERNS`). It is a RETRYABLE, "waking" state, not
 * a terminal failure: a consumer must render it as loading and keep polling,
 * never as an error and never as an empty result.
 *
 * Thrown by `readSessionMessagePage` and the framework-free HTTP page loader so
 * `SessionSyncController` can tell "the box is waking" (freshness `loading`,
 * keep retrying) apart from "the read genuinely failed" (freshness `error`).
 * Its `message` always matches `isSandboxNotReadyError`, so a consumer that
 * only has the string still classifies it correctly.
 */
export class SandboxNotReadyError extends Error {
  constructor(detail?: string) {
    const trimmed = detail?.trim();
    super(
      trimmed && isSandboxNotReadyError(trimmed)
        ? trimmed
        : trimmed
          ? `sandbox not ready: ${trimmed}`
          : 'sandbox not ready',
    );
    this.name = 'SandboxNotReadyError';
  }
}

export function formatRuntimeError(error: unknown): {
  title: string;
  message: string;
  detail?: string;
} {
  const raw = rawErrorMessage(error);

  // A parked or still-provisioning box is not a crash. The proxy answers with
  // a readiness phrase for a sandbox the control plane stopped ON PURPOSE to
  // save compute (or has not finished booting), and the conversation is intact
  // behind it. Reserve "The session runtime failed to load" for a runtime that
  // genuinely broke.
  //
  // Matched against the raw string, not a `parseRuntimeErrorPayload` field:
  // `unwrap()` (react/use-runtime-sessions/shared.ts) is what actually
  // produces the error this function receives for the session-list poll that
  // drives the page's runtime-error card, and it throws `new Error(body.error)`
  // — just the bare phrase, with the JSON wrapper already stripped off. There
  // is no payload left to parse by the time it gets here.
  if (isSandboxNotReadyError(raw)) {
    return {
      title: 'Session is waking up',
      message:
        'This session slept to save compute. Your conversation is safe — sending a message wakes it back up.',
    };
  }

  return {
    title: 'The session runtime failed to load',
    message: raw || 'The sandbox is running, but its runtime returned an error.',
  };
}

