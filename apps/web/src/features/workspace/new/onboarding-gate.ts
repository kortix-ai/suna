/**
 * Whether a freshly-created project should show the guided onboarding
 * wizard.
 *
 * `ProjectOnboardingWizard` (`components/projects/project-onboarding-wizard.tsx:154,178`)
 * is mounted unconditionally on every project shell
 * (`features/workspace/project-layout/project-shell.tsx:198`) and self-gates
 * on the PROJECT's own `metadata.onboarding_completed_at`
 * (`useProjectOnboarding`, `hooks/projects/use-project-onboarding.ts`):
 * `status === 'pending'` (no timestamp yet) renders it, `'completed'` does
 * not. A brand-new project never has the timestamp, so today EVERY create
 * shows the wizard.
 *
 * This function does not touch that mechanism — it decides whether
 * `useCreateWorkspace` should pre-empt it by stamping the new project
 * onboarded via `PATCH /projects/:id/onboarding` (the same endpoint
 * `useProjectOnboarding.complete()` already calls) before the wizard ever
 * gets a chance to render. The account's FIRST project should still run the
 * wizard (there is nothing yet to skip); every later project in that same
 * account already has the account-scoped setup (tools, Slack, model) done,
 * so the wizard is redundant there.
 *
 * `existingProjectCount` is the account's project count taken BEFORE this
 * create — see `use-create-workspace.ts`'s `runCreate` for why "before" is
 * load-bearing (reading it after the create would always see at least the
 * project just created, and this function would never see 0 again).
 */
export function shouldRunOnboarding({
  existingProjectCount,
}: {
  existingProjectCount: number;
}): boolean {
  return existingProjectCount < 1;
}
