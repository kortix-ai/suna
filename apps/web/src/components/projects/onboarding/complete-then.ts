/**
 * Finish onboarding and tell the host at once — whether or not the finish
 * persists.
 *
 * The host is told BEFORE the stamp settles. `complete()` applies the stamp
 * to the cache optimistically, so the navigation has nothing to wait for;
 * awaiting the PATCH showed the "Creating …" loader for a full round trip
 * after the last click.
 *
 * Extracted from `ProjectOnboardingWizard` rather than inlined so this rule is
 * testable at all: the wizard cannot be rendered in `apps/web`'s test harness
 * (no jsdom, and `mock.module('@tanstack/react-query', …)` would be
 * process-wide across a non---isolate `bun test` run), so an inline
 * try/catch would be provable only by reading it.
 *
 * The swallow is deliberate and is the point of the function. `complete()`
 * PATCHes `metadata.onboarding_completed_at`; the wizard is a fullscreen
 * modal with no close button and no outside-click dismiss. If a failed stamp
 * skipped the notify, the user would be sealed in that modal by a network
 * blip. The failure mode we accept instead is one extra wizard render the
 * next time they open the workspace.
 */
export function completeThenNotify(
  complete: () => Promise<unknown>,
  notify: (() => void) | undefined,
): Promise<void> {
  const settled = complete().then(
    () => undefined,
    // Intentionally silent — see the module comment. The caller has no
    // recovery to offer and the user asked to move on, not to retry a flag.
    () => undefined,
  );
  notify?.();
  return settled;
}
