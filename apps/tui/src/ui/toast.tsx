import { useEffect } from 'react';

import { theme } from '../theme.ts';

export type ToastKind = 'info' | 'error';

export interface ToastProps {
  message: string;
  kind?: ToastKind;
  /** Auto-dismiss delay. 0 keeps it until the caller clears it. */
  timeoutMs?: number;
  /**
   * `bottom`: above the status bar (the screens). `top`: under the session
   * header — the session screen has no status bar, and a bottom toast would
   * sit on the input.
   */
  placement?: 'top' | 'bottom';
  onDismiss?: () => void;
}

/**
 * A one-line notice pinned to the right: above the status bar, or under the
 * session header.
 *
 * Give it `key={message}` when the same mount can show different messages:
 * the dismiss timer starts on mount, so a remount is what restarts it.
 */
export function Toast({
  message,
  kind = 'info',
  timeoutMs = 4000,
  onDismiss,
  placement = 'bottom',
}: ToastProps) {
  useEffect(() => {
    if (!timeoutMs) return;
    const timer = setTimeout(() => onDismiss?.(), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs, onDismiss]);

  return (
    <box
      position="absolute"
      {...(placement === 'top' ? { top: 1 } : { bottom: 1 })}
      right={2}
      zIndex={90}
      border
      borderStyle="single"
      borderColor={kind === 'error' ? theme.danger : theme.border}
      backgroundColor={theme.surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={kind === 'error' ? theme.danger : theme.fg}>{message}</text>
    </box>
  );
}
