/**
 * SSO-only sign-in (KRTX-1716). An account can require single sign-on for its
 * verified email domain. The API then refuses every other credential for that
 * domain with 403 `sso_required`: a password, an email code, Google, Apple.
 *
 * Two paths open the email screen in its SSO mode
 * (`app/auth/email.tsx?reason=sso_required`):
 * - Before a password, email-code, sign-up or password-reset attempt,
 *   `emailRequiresSso` asks the public `POST /v1/access/check-email`, the web
 *   form's pre-check. When it answers `sso`, GoTrue is not called. A failed or
 *   slow check never blocks sign-in: the API still refuses the session, and
 *   the second path catches it.
 * - A signed-in session that gets 403 `sso_required` from an SDK REST call
 *   (`onAccessRemedy` in `app/_layout.tsx`, `reportAccessRemedy` here) sets
 *   `useSsoRequiredStore`. `SsoRequiredSignOut` (components/auth) signs out
 *   and opens the SSO screen with the email filled in.
 */

import { create } from 'zustand';

import { withDeadline } from '@/lib/utils/with-deadline';

/** The web pre-check's limit (`checkEmailFlowMode`). Past it, sign-in proceeds. */
export const SSO_CHECK_DEADLINE_MS = 4_000;

/** True when a `POST /v1/access/check-email` body says the email must use SSO. */
export function isSsoMode(check: unknown): boolean {
  return (check as { mode?: unknown } | null | undefined)?.mode === 'sso';
}

/** Fails open: an error, a timeout or any other answer is false. */
export async function emailRequiresSso(
  email: string,
  check: (email: string) => Promise<unknown>,
  deadlineMs = SSO_CHECK_DEADLINE_MS
): Promise<boolean> {
  try {
    return isSsoMode(await withDeadline(check(email), deadlineMs, null));
  } catch {
    return false;
  }
}

/** `reported`: an API call answered 403 `sso_required` and the sign-out has not run yet. */
export const useSsoRequiredStore = create<{ reported: boolean }>(() => ({ reported: false }));

/**
 * The SDK's `onAccessRemedy` (app/_layout.tsx). Only `sso_required` signs out:
 * `account_mfa_required` asks for a step-up, not a new sign-in.
 */
export function reportAccessRemedy(code: 'sso_required' | 'account_mfa_required'): void {
  if (code === 'sso_required') useSsoRequiredStore.setState({ reported: true });
}
