/**
 * What the app shows about an attach.
 *
 * While opencode runs, the renderer is suspended and these components are not
 * on screen — the status lines go to plain stdout (see `runAttach`). This is
 * the BEFORE and AFTER surface: the last stage reached while the attach was
 * being set up, and the outcome once the TUI repaints.
 */

import { theme } from '../../theme.ts';
import { Toast, type ToastKind } from '../../ui/index.ts';
import type { AttachFailure, AttachStatus, RunAttachResult } from './attach.ts';

const STAGE_LABEL: Record<AttachStatus['stage'], string> = {
  resolving: 'Resolving the session',
  restarting: 'Starting the sandbox',
  'downloading-binary': 'Preparing the opencode binary',
  'proxy-ready': 'Proxy ready',
  attached: 'Attached',
};

/** One line, for a banner in the session view while an attach is being set up. */
export function attachStatusLine(status: AttachStatus): string {
  return `${STAGE_LABEL[status.stage]} — ${status.detail}`;
}

/** The toast text for a finished attach. */
export function attachResultToast(result: RunAttachResult): { message: string; kind: ToastKind } {
  if ('error' in result) {
    return {
      message: `Attach failed at ${result.error.stage}: ${result.error.message}`,
      kind: 'error',
    };
  }
  if (result.exitCode === 0) return { message: 'opencode exited.', kind: 'info' };
  return { message: `opencode exited with code ${result.exitCode}.`, kind: 'error' };
}

export interface AttachStatusBannerProps {
  status: AttachStatus | null;
  error?: AttachFailure | null;
}

/** The in-TUI banner. Null status and null error render nothing. */
export function AttachStatusBanner({ status, error }: AttachStatusBannerProps) {
  if (error) {
    return <text fg={theme.danger}>{`Attach failed at ${error.stage}: ${error.message}`}</text>;
  }
  if (!status) return null;
  return <text fg={theme.dim}>{attachStatusLine(status)}</text>;
}

export interface AttachResultToastProps {
  result: RunAttachResult | null;
  onDismiss: () => void;
}

/** The toast the app shows once the TUI has repainted. */
export function AttachResultToast({ result, onDismiss }: AttachResultToastProps) {
  if (!result) return null;
  const { message, kind } = attachResultToast(result);
  return <Toast key={message} message={message} kind={kind} onDismiss={onDismiss} />;
}
