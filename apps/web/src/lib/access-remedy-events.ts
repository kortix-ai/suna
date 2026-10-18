/**
 * The DOM half of the SDK's access-remedy seam (KRTX-2729
 * move-response-error-remedy-dispatch): the SDK core emits the semantic
 * `onAccessRemedy` code, the host owns the DOM. apps/web's listeners
 * (`MfaStepUpProvider`, `SsoRequiredProvider` in layout.tsx) listen on these
 * two CustomEvent names; the feature components re-export them.
 */
export const MFA_REQUIRED_EVENT = 'kortix:mfa-required';
export const SSO_REQUIRED_EVENT = 'kortix:sso-required';

export function dispatchAccessRemedyEvent(code: 'sso_required' | 'account_mfa_required'): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(
      new CustomEvent(code === 'account_mfa_required' ? MFA_REQUIRED_EVENT : SSO_REQUIRED_EVENT),
    );
  } catch {}
}
