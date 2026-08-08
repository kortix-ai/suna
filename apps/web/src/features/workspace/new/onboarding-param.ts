/**
 * `/new?onboarding=<projectId>` — the workspace exists and the guided
 * onboarding is running on `/new` for it, before the user is sent into it.
 *
 * The param is what makes that state survive a reload: without it, refreshing
 * mid-onboarding would drop the user back on an empty create form with a
 * workspace they never saw.
 *
 * Sibling of `clone-param.ts`, and validated the same way — emptiness only.
 * A project id the caller cannot read fails safe downstream: the wizard's
 * `useProjectOnboarding` query errors, `hydrated` stays false, and the wizard
 * renders `null` rather than trapping the user in a broken overlay.
 */
export const ONBOARDING_PARAM = 'onboarding';

/**
 * `encodeURIComponent`, not raw interpolation: a project id is opaque to this
 * module, and an unescaped `&` or `=` would silently split into a second
 * param and lose the tail of the id.
 */
export function onboardingPath(projectId: string): string {
  return `/new?${ONBOARDING_PARAM}=${encodeURIComponent(projectId)}`;
}

export function readOnboardingParam(params: URLSearchParams): string | null {
  const raw = params.get(ONBOARDING_PARAM);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}
