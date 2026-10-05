// Pure sandbox-provider precedence for new sessions. No deps — config/db are
// injected as `allowed` + `isEnabled` — so it unit-tests without env/DB and stays
// importable in isolation. Used by createProjectSession (projects/lib/sessions.ts).

/**
 * Resolve the sandbox provider for a new session. Precedence:
 *   1. explicit request (`body.provider`) — validated against ALLOWED, 400 on miss;
 *   2. the per-project pin (`metadata.default_sandbox_provider`) — used only if
 *      still ENABLED (allowed + API key present). This intentionally bypasses the
 *      distribution WEIGHTS, so a project can be pinned to e.g. platinum even when
 *      platinum's weight is 0. A stale/disabled pin is silently ignored, never a
 *      hard create failure;
 *   3. `{ fallback: true }` → the caller runs the weighted balancer (selectProvider()).
 */
export function resolveSessionProvider(opts: {
  requested: string | null;
  projectPin: string | null;
  allowed: readonly string[];
  isEnabled: (provider: string) => boolean;
}): { provider: string } | { badRequest: string } | { fallback: true } {
  if (opts.requested) {
    if (!opts.allowed.includes(opts.requested)) return { badRequest: opts.requested };
    return { provider: opts.requested };
  }
  if (opts.projectPin && opts.isEnabled(opts.projectPin)) return { provider: opts.projectPin };
  return { fallback: true };
}

/**
 * Is the resolved provider a HARD requirement, or merely the balancer's pick?
 *
 * Only an explicit `body.provider` or an enabled per-project pin locks the
 * runtime. A weighted-balancer choice must stay UNLOCKED so the one-shot,
 * admin-gated provider failover in `provisionSessionSandbox` can hand the
 * session to another allowed provider when the primary fails at birth.
 *
 * Regression this exists to prevent: `createProjectSession` resolves the
 * balancer's pick and passes it down as `provider`, which the provisioner used
 * to read as "explicitly selected". That made failover unreachable for EVERY
 * project session — on 2026-08-26 654 sessions died on a provider at capacity
 * with `provider_fallback` enabled and zero handoffs recorded.
 */
export function sessionProviderIsLocked(
  picked: ReturnType<typeof resolveSessionProvider>,
): boolean {
  return 'provider' in picked;
}

/**
 * Which provider(s) a build-on-push warm prebake should target for a project —
 * i.e. the providers a session on this project could actually land on. Mirrors
 * {@link resolveSessionProvider} minus the per-request override (a push carries
 * no session context):
 *   - an ENABLED per-project pin ⇒ every session uses exactly that provider, so
 *     warm ONLY it (no wasted bake for providers the project never boots on);
 *   - otherwise ⇒ sessions fall to the weighted balancer, which can pick ANY
 *     enabled provider, so warm ALL of them for symmetric parity.
 * A stale/disabled/absent pin degrades to the "all enabled" case (never a bake
 * on a provider that can't run). Pure — `allowed`/`isEnabled` are injected, so it
 * unit-tests without env/DB.
 */
export function warmPrebakeProviders(opts: {
  projectPin: string | null;
  allowed: readonly string[];
  isEnabled: (provider: string) => boolean;
  /** Legacy warm mode fans out. Explicit FAST mode waits for provider selection. */
  fanoutWhenUnpinned?: boolean;
}): string[] {
  if (opts.projectPin && opts.allowed.includes(opts.projectPin) && opts.isEnabled(opts.projectPin)) {
    return [opts.projectPin];
  }
  if (opts.fanoutWhenUnpinned === false) return [];
  return opts.allowed.filter((p) => opts.isEnabled(p));
}

/**
 * The provider a failing-at-birth session hands off to, or null when failover
 * must not run. Pure mirror of the guard in `provisionSessionSandbox` so the
 * rule is testable without a provider, a DB, or a sandbox.
 *
 *   - `providerLocked`     — an explicit request or project pin. Never override.
 *   - `fallbackAttempted`  — failover is ONE shot per session.
 *   - `fallbackEnabled`    — admin gate (`platform_settings.provider_fallback`).
 */
export function nextFailoverProvider(input: {
  providerLocked: boolean;
  fallbackAttempted: boolean;
  fallbackEnabled: boolean;
  current: string;
  allowed: readonly string[];
}): string | null {
  if (input.providerLocked || input.fallbackAttempted || !input.fallbackEnabled) return null;
  return input.allowed.find((p) => p !== input.current) ?? null;
}
