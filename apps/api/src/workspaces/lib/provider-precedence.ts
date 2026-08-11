// Pure sandbox-provider precedence for new sessions. No deps — config/db are
// injected as `allowed` + `isEnabled` — so it unit-tests without env/DB and stays
// importable in isolation. Used by createWorkspaceSession (projects/lib/sessions.ts).

/**
 * Resolve the sandbox provider for a new session. Precedence:
 *   1. explicit request (`body.provider`) — validated against ALLOWED, 400 on miss;
 *   2. the per-workspace pin (`metadata.default_sandbox_provider`) — used only if
 *      still ENABLED (allowed + API key present). This intentionally bypasses the
 *      distribution WEIGHTS, so a project can be pinned to e.g. platinum even when
 *      platinum's weight is 0. A stale/disabled pin is silently ignored, never a
 *      hard create failure;
 *   3. `{ fallback: true }` → the caller runs the weighted balancer (selectProvider()).
 */
export function resolveSessionProvider(opts: {
  requested: string | null;
  workspacePin: string | null;
  allowed: readonly string[];
  isEnabled: (provider: string) => boolean;
}): { provider: string } | { badRequest: string } | { fallback: true } {
  if (opts.requested) {
    if (!opts.allowed.includes(opts.requested)) return { badRequest: opts.requested };
    return { provider: opts.requested };
  }
  if (opts.workspacePin && opts.isEnabled(opts.workspacePin)) return { provider: opts.workspacePin };
  return { fallback: true };
}

/**
 * Which provider(s) a build-on-push warm prebake should target for a project —
 * i.e. the providers a session on this workspace could actually land on. Mirrors
 * {@link resolveSessionProvider} minus the per-request override (a push carries
 * no session context):
 *   - an ENABLED per-workspace pin ⇒ every session uses exactly that provider, so
 *     warm ONLY it (no wasted bake for providers the workspace never boots on);
 *   - otherwise ⇒ sessions fall to the weighted balancer, which can pick ANY
 *     enabled provider, so warm ALL of them for symmetric parity.
 * A stale/disabled/absent pin degrades to the "all enabled" case (never a bake
 * on a provider that can't run). Pure — `allowed`/`isEnabled` are injected, so it
 * unit-tests without env/DB.
 */
export function warmPrebakeProviders(opts: {
  workspacePin: string | null;
  allowed: readonly string[];
  isEnabled: (provider: string) => boolean;
}): string[] {
  if (opts.workspacePin && opts.allowed.includes(opts.workspacePin) && opts.isEnabled(opts.workspacePin)) {
    return [opts.workspacePin];
  }
  return opts.allowed.filter((p) => opts.isEnabled(p));
}
