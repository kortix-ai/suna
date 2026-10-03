import type { DesktopCaptureSignIn, DesktopCaptureSignInResult } from '@/lib/desktop';

export interface ConnectDesktopCaptureDeps {
  /** `capture_sign_in_start`: the engine asks its issuer for a device code. */
  start: () => Promise<DesktopCaptureSignIn | null>;
  /** The person's own approval of that code (SDK `approveCaptureDeviceGrant`). */
  approve: (userCode: string, projectId: string) => Promise<unknown>;
  /** `capture_sign_in_finish`: resolves once the engine holds its device token. */
  finish: () => Promise<DesktopCaptureSignInResult | null>;
  cancel: () => Promise<unknown>;
  /** The approval page, when this session could not approve in place. */
  openApproval: (url: string) => void;
}

/**
 * Signs this desktop's Capture engine in to `projectId` without a second
 * browser trip: the engine starts an RFC 8628 device grant, this signed-in
 * person approves its code with their own session, and the engine receives
 * its device token. When the in-place approval fails, the approval page opens
 * instead (the person approves there) and the sign-in keeps waiting for it.
 */
export async function connectDesktopCapture(
  projectId: string,
  deps: ConnectDesktopCaptureDeps,
): Promise<DesktopCaptureSignInResult> {
  const started = await deps.start();
  if (!started) return { ok: false, error: 'This desktop app has no Kortix Capture.' };
  if (!started.ok || !started.userCode)
    return { ok: false, error: started.error || 'Capture sign-in did not start.' };
  try {
    await deps.approve(started.userCode, projectId);
  } catch (error) {
    if (!started.verificationUrl) {
      await deps.cancel().catch(() => {});
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    deps.openApproval(started.verificationUrl);
  }
  return (await deps.finish()) ?? { ok: false, error: 'The desktop app stopped answering.' };
}
