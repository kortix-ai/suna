import type { DesktopCaptureLayer, DesktopCaptureStatus } from '@/lib/desktop';

/**
 * What the "Record this computer" dialog shows, from the desktop app's
 * `capture_status`, the project, and the dialog's own pending work. One phase
 * at a time; the dialog renders exactly one primary action per phase.
 */
export type CapturePhase =
  | 'unavailable' // no engine in this build, or it cannot run here
  | 'projectOff' // the project's `capture` flag is off
  | 'off' // not recording into this project (signed out, another project, or switched off)
  | 'turningOn' // device sign-in and service install in progress
  | 'signInRequired' // Kortix refused this computer (revoked, or the flag went off): sign in again
  | 'error' // the last action failed, or the recorder keeps crashing
  | 'needsPermission' // on, but macOS has not granted what the layers need
  | 'paused' // on, paused by the person or by the project policy
  | 'starting' // on, the recorder has not reported yet
  | 'recording';

export type CaptureGrant = 'screen' | 'accessibility' | 'inputMonitoring' | 'microphone';
export const CAPTURE_LAYERS: readonly DesktopCaptureLayer[] = ['screen', 'actions', 'audio'];

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

/** Layers that record now: switched on here and allowed by the project policy. */
export function activeLayers(view: DesktopCaptureStatus): DesktopCaptureLayer[] {
  return CAPTURE_LAYERS.filter(
    (layer) => view.layers?.[layer] && view.policy?.layers[layer] !== false,
  );
}

export function capturePhase(
  view: DesktopCaptureStatus | null | undefined,
  {
    projectId,
    projectHasCapture,
    turningOn = false,
    failed = false,
    now = Date.now(),
  }: {
    projectId: string;
    projectHasCapture: boolean;
    turningOn?: boolean;
    failed?: boolean;
    now?: number;
  },
): CapturePhase {
  if (!view?.available) return 'unavailable';
  if (!projectHasCapture) return 'projectOff';
  if (turningOn) return 'turningOn';
  const here = view.projectId === projectId;
  if (view.signInRequired && here) return 'signInRequired';
  if (failed) return 'error';
  // `stopped`: the service was stopped outside the app; Record starts it again.
  if (!view.signedIn || !here || !view.on || view.state === 'stopped') return 'off';
  if (view.state === 'crashed') return 'error';
  if (view.state === 'paused' || view.policy?.paused || (view.pausedUntilMs ?? 0) > now)
    return 'paused';
  if (
    view.state === 'permission_missing' ||
    view.state === 'permission_needed' ||
    missingGrants(view).length > 0
  )
    return 'needsPermission';
  if (view.state === 'recording') return 'recording';
  return 'starting';
}
