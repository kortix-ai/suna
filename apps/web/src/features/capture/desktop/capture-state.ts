import { CAPTURE_LAYERS } from '@kortix/sdk';

import type { DesktopCaptureLayer, DesktopCaptureStatus } from '@/lib/desktop';

/**
 * What the "Record this computer" dialog shows, from the desktop app's
 * `capture_status`, the account's Capture switch, and the dialog's own pending work. One phase
 * at a time; the dialog renders exactly one primary action per phase.
 */
export type CapturePhase =
  | 'unavailable' // no engine in this build, or it cannot run here
  | 'captureOff' // Capture is off for the account
  | 'off' // not recording into this account (signed out, another account, or switched off)
  | 'turningOn' // device sign-in and service install in progress
  | 'signInRequired' // Kortix refused this computer (revoked, or the flag went off): sign in again
  | 'error' // the last action failed, or the recorder keeps crashing
  | 'needsPermission' // on, but macOS has not granted what the layers need
  | 'paused' // on, paused by the person or by the account policy
  | 'locked' // on; the screen is locked, recording resumes on unlock
  | 'excluded' // on; an excluded app, website or private window is in front
  | 'starting' // on, the recorder has not reported yet
  | 'recording'
  | 'managed'; // IT manages this computer, and it does not record into this account (yet)

const EXCLUDED_REASONS = new Set([
  'excluded_app',
  'excluded_domain',
  'private_browsing',
  'unknown_bundle',
]);

export type CaptureGrant = 'screen' | 'accessibility' | 'inputMonitoring' | 'microphone';

/**
 * The macOS grants the switched-on layers need and macOS has not given:
 * Screen Recording and Accessibility always, Input Monitoring with Actions
 * (when the engine reports it), the Microphone with Audio.
 */
export function missingGrants(view: DesktopCaptureStatus): CaptureGrant[] {
  const permissions = view.permissions;
  if (!permissions) return [];
  const actions = view.layers?.actions && view.policy?.layers.actions !== false;
  const needed: CaptureGrant[] = [
    'screen',
    'accessibility',
    ...(actions && permissions.inputMonitoring !== undefined ? (['inputMonitoring'] as const) : []),
    ...(view.layers?.audio ? (['microphone'] as const) : []),
  ];
  return needed.filter((grant) => !permissions[grant]);
}

/** Layers that record now: switched on here and allowed by the account policy. */
export function activeLayers(view: DesktopCaptureStatus): DesktopCaptureLayer[] {
  return CAPTURE_LAYERS.filter(
    (layer) => view.layers?.[layer] && view.policy?.layers[layer] !== false,
  );
}

export function capturePhase(
  view: DesktopCaptureStatus | null | undefined,
  {
    accountId,
    captureOn,
    turningOn = false,
    failed = false,
    now = Date.now(),
  }: {
    accountId: string | null;
    captureOn: boolean;
    turningOn?: boolean;
    failed?: boolean;
    now?: number;
  },
): CapturePhase {
  if (!view?.available) return 'unavailable';
  if (!captureOn) return 'captureOff';
  if (turningOn) return 'turningOn';
  const here = !!accountId && view.accountId === accountId;
  // IT's service records whoever signs in to Windows: no switch, no sign-in here.
  if (view.managed && (view.managed.enrollment !== 'enrolled' || !here)) return 'managed';
  if (view.signInRequired && here) return 'signInRequired';
  if (failed) return 'error';
  // `stopped`: the service was stopped outside the app; Record starts it again.
  if (!view.managed && (!view.signedIn || !here || !view.on || view.state === 'stopped')) return 'off';
  if (view.state === 'crashed') return 'error';
  // A lock or an excluded app in front stops recording without anyone pausing it (the engine's reason).
  const stopped = view.state === 'paused' || view.state === 'not_recording';
  if (stopped && view.reason === 'locked') return 'locked';
  if (stopped && EXCLUDED_REASONS.has(view.reason ?? '')) return 'excluded';
  if (view.state === 'paused' || view.policy?.paused || (view.pausedUntilMs ?? 0) > now)
    return 'paused';
  if (view.state === 'permission_missing' || missingGrants(view).length > 0)
    return 'needsPermission';
  if (view.state === 'recording') return 'recording';
  return 'starting';
}
