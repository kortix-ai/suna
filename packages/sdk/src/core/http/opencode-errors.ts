export interface OpenCodeConfigIssue {
  path?: unknown[];
  message?: string;
}

export interface OpenCodeConfigInvalidError {
  name: 'ConfigInvalidError';
  data?: {
    path?: string;
    issues?: OpenCodeConfigIssue[];
  };
}

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

export function parseOpenCodeErrorPayload(error: unknown): unknown {
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

export function getOpenCodeConfigInvalidError(error: unknown): OpenCodeConfigInvalidError | null {
  const payload = parseOpenCodeErrorPayload(error);
  if (!payload || typeof payload !== 'object') return null;
  const maybe = payload as Partial<OpenCodeConfigInvalidError>;
  return maybe.name === 'ConfigInvalidError' ? (maybe as OpenCodeConfigInvalidError) : null;
}

export function isOpenCodeConfigInvalidError(error: unknown): boolean {
  return getOpenCodeConfigInvalidError(error) !== null;
}

// Every readiness phrase the API can answer with while a sandbox (or the
// OpenCode server inside it) is provisioning, resuming, or parked. Each line
// maps to a production site in apps/api:
//   - `sandbox not ready (status: X)` / bare `sandbox not ready`
//     → sandbox-proxy/routes/preview.ts (HTTP proxy + WebSocket resolver)
//   - `Sandbox is not running` → sandbox-proxy/routes/public-share.ts
//   - `Sandbox is not ready` → public-session-shares, shared/session-public-shares
//   - `opencode … not ready` → daemon 503 pass-through, session-transcript,
//     public-session-share-view
//   - `sandbox_not_ready`, `sandbox_lifecycle_unavailable` → machine codes on
//     503 bodies from the sandbox proxy
// Deliberately NOT here: `sandbox port unreachable` — that is emitted only
// after the box reported active and the port still failed to answer, which is
// a genuine failure, not parking.
const SANDBOX_NOT_READY_PATTERNS: readonly RegExp[] = [
  /sandbox not ready/i,
  /sandbox is not (?:ready|running)/i,
  /opencode (?:session )?(?:is )?not ready/i,
  /\bsandbox_not_ready\b/,
  /\bsandbox_lifecycle_unavailable\b/,
  // The sandbox-proxy state page for a stopped/idle box the control plane can
  // wake (dev, 2026-08-27): `404  This sandbox URL is not active.  not-running`.
  // A box in this state is parked, not gone — the same wakeable state as a 503
  // `sandbox not ready (status: stopped)`. Without these the transcript read
  // dead-ended on the 404 and painted "Couldn't load this conversation" over a
  // session that only needed a wake. Specific enough to never match a genuine
  // `{"message":"Not found"}` 404. See session-sync-registry.readSessionMessagePage.
  /sandbox url is not active/i,
  /\bnot-running\b/,
];

/**
 * True when an error means "the sandbox is still starting / parked", i.e. a
 * readiness state the control plane reports on purpose. A UI must render this
 * as a pending "waking up" state and keep polling — never as a terminal error.
 * Accepts an `Error`, the raw message string, or a JSON body containing one.
 */
export function isSandboxNotReadyError(error: unknown): boolean {
  const raw = rawErrorMessage(error);
  if (!raw) return false;
  return SANDBOX_NOT_READY_PATTERNS.some((pattern) => pattern.test(raw));
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

export function formatOpenCodeRuntimeError(error: unknown): {
  title: string;
  message: string;
  detail?: string;
} {
  const configError = getOpenCodeConfigInvalidError(error);
  if (configError) {
    const workspacePath = configError.data?.path ?? 'OpenCode config';
    const repoPath = workspacePath.replace(/^\/workspace\//, '');
    const issue = configError.data?.issues?.[0]?.message;
    const issuePath = configError.data?.issues?.[0]?.path?.join('.');
    const permissionHint = issuePath?.startsWith('permission')
      ? 'Remove the invalid permission frontmatter entry or replace it with valid OpenCode permission config.'
      : 'Fix the invalid config entry, then restart this session.';

    return {
      title: 'OpenCode config is invalid',
      message: `${repoPath} is preventing OpenCode from loading. ${permissionHint}`,
      detail: issue ? `${issuePath ? `${issuePath}: ` : ''}${issue}` : undefined,
    };
  }

  const raw = rawErrorMessage(error);

  // A parked or still-provisioning box is not a crash. The proxy answers with
  // a readiness phrase for a sandbox the control plane stopped ON PURPOSE to
  // save compute (or has not finished booting), and the conversation is intact
  // behind it. Reserve "OpenCode failed to load" for a runtime that genuinely
  // broke.
  //
  // Matched against the raw string, not a `parseOpenCodeErrorPayload` field:
  // `unwrap()` (react/use-opencode-sessions/shared.ts) is what actually
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
    title: 'OpenCode failed to load',
    message: raw || 'The sandbox is running, but OpenCode returned an error.',
  };
}
