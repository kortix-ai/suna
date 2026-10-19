/**
 * The one action waiting on a TOTP step-up. A new request replaces the old
 * one, and cancelling the dialog clears it, so a cancelled action never runs
 * at a later verification.
 */
let pending: (() => void) | null = null;

export const MFA_VERIFIED_EVENT = 'kortix:mfa-verified';
/** Dispatched to open the step-up dialog (`MfaStepUpProvider`, mounted by the app). */
export const MFA_REQUIRED_EVENT = 'kortix:mfa-required';

export function armPendingMfaAction(action: () => void): void {
  pending = action;
  // Same function reference: adding it again is a no-op, so this is one listener.
  if (typeof window !== 'undefined') window.addEventListener(MFA_VERIFIED_EVENT, runPendingMfaAction);
}

export function clearPendingMfaAction(): void {
  pending = null;
}

/** Run the armed action once, then empty the slot. */
export function runPendingMfaAction(): void {
  const action = pending;
  pending = null;
  action?.();
}
