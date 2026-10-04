import type { SessionRuntimeEntry } from '../session/session-runtime-registry';
/** A model the agent can run, as the opencode runtime identifies it. */
export type SessionModel = { providerID: string; modelID: string };

/**
 * Dedupes concurrent `ensureReady()` calls that would otherwise both drive a
 * `/start` long-poll for the SAME (projectId, sessionId) — e.g. two session
 * handles for the same session (or the facade racing the React `useSession`
 * hook) both calling `ensureReady()`/`start()` before either has resolved a
 * runtime. Keyed by `${projectId}\n${sessionId}` (not the process-global
 * "active runtime" — every other handle for a DIFFERENT session gets its own
 * entry and is unaffected). Cleared on settle (success or failure) so a
 * transient failure doesn't wedge the key — the next call issues a fresh
 * `/start` instead of replaying a stale rejected promise forever.
 */
export const inFlightSessionStarts = new Map<string, Promise<SessionRuntimeEntry>>();

/**
 * Build the `RUNTIME_UNAVAILABLE` message from a not-ready `/start` result.
 *
 * The server already earns a concrete reason on a terminal `stage:"failed"` —
 * `failure.category`/`failure.message`, its `failure.evidence.error`, or a
 * plain `reason` (see `SessionStartResultSchema` in `@kortix/api-contract`).
 * Before this, the caller threw only `(stage: <stage>)` and dropped all of it,
 * so `kortix sessions log`/`sessions new --wait` surfaced a bare
 * `Session runtime not ready (stage: failed)` with no cause — the operator
 * could not tell a provider-capacity failure from a git-auth failure
 * (incident-20260922T140537Z-kxhourly). Keep the stage for continuity and
 * append the concrete reason when the result carries one.
 */
export function runtimeNotReadyMessage(
  started:
    | {
        stage?: string;
        reason?: string;
        failure?: {
          category?: string;
          message?: string;
          evidence?: { error?: string | null } | null;
        } | null;
      }
    | null
    | undefined,
): string {
  const base = `Session runtime not ready (stage: ${started?.stage ?? 'unknown'})`;
  const failure = started?.failure;
  const parts: string[] = [];
  if (failure?.category) parts.push(failure.category);
  if (failure?.message) parts.push(failure.message);
  const providerError = failure?.evidence?.error;
  if (providerError && providerError !== failure?.message) parts.push(providerError);
  // `reason` is the coarser fallback the server sends without a `failure` block.
  if (parts.length === 0 && started?.reason) parts.push(started.reason);
  return parts.length > 0 ? `${base}: ${parts.join(' — ')}` : base;
}

export class SessionNotReadyError extends Error {
  constructor(action: string) {
    super(
      `Session runtime not ready — call \`await session.ensureReady()\` (it drives \`start()\` to completion and resolves this session's own sandbox runtime) before calling \`${action}\`.`,
    );
    this.name = 'SessionNotReadyError';
  }
}
