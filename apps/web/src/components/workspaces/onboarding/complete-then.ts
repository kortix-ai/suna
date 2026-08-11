/**
 * Finish onboarding, then tell the host — whether or not the finish actually
 * persisted.
 *
 * Extracted from `WorkspaceOnboardingWizard` rather than inlined so this rule is
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
export async function completeThenNotify(
  complete: () => Promise<unknown>,
  notify: (() => void) | undefined,
): Promise<void> {
  try {
    await complete();
  } catch {
    // Intentionally silent — see the module comment. The caller has no
    // recovery to offer and the user asked to move on, not to retry a flag.
  }
  notify?.();
}
