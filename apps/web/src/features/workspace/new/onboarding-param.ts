/**
 * `/new?onboarding=<workspaceId>` — the workspace exists and the guided
 * onboarding is running on `/new` for it, before the user is sent into it.
 *
 * The param is what makes that state survive a reload: without it, refreshing
 * mid-onboarding would drop the user back on an empty create form with a
 * workspace they never saw.
 *
 * Sibling of `clone-param.ts`, and validated the same way — emptiness only.
 *
 * A workspace id the caller cannot read does NOT fail safe, and it is worth being
 * exact about why: `useWorkspaceOnboarding` derives `hydrated` from
 * `!detail.isLoading`, and TanStack sets `isLoading` false once a query SETTLES
 * — including settling as an error. So on a 403/404 the wizard sees
 * `hydrated: true`, no metadata to read, `status: 'pending'` — and it RENDERS,
 * over a workspace the user cannot open.
 *
 * That is tolerated on this route and nowhere else. The id here is one this
 * page itself wrote a moment earlier, after its own successful create, so it is
 * self-inflicted rather than attacker- or link-supplied; the realistic trigger
 * is read-after-write lag on a workspace that does exist. `/new` also gives the
 * wizard a "Skip for now" control and keeps a "Go to workspace" link on the
 * page beneath it, so neither outcome is a trap. The surface where a bad id
 * would matter is the workspace shell, and `workspace-shell.tsx` already redirects
 * on a 403/404 detail error before its copy of the wizard can mount.
 */
export const ONBOARDING_PARAM = 'onboarding';

/**
 * `encodeURIComponent`, not raw interpolation: a workspace id is opaque to this
 * module, and an unescaped `&` or `=` would silently split into a second
 * param and lose the tail of the id.
 */
export function onboardingPath(workspaceId: string): string {
  return `/new?${ONBOARDING_PARAM}=${encodeURIComponent(workspaceId)}`;
}

export function readOnboardingParam(params: URLSearchParams): string | null {
  const raw = params.get(ONBOARDING_PARAM);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}
