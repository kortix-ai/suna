import { useEffect, useRef } from 'react';

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
  // The callback is read through a ref: hosts pass an inline arrow, and with it
  // in the deps every parent render (a streaming turn renders many times a
  // second) restarted the timer — measured: a 4 s toast stayed up ~20 s.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!timeoutMs) return;
    const timer = setTimeout(() => dismissRef.current?.(), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs]);

  return (
    <box
      position="absolute"
      {...(placement === 'top' ? { top: 1 } : { bottom: 1 })}
      right={2}
      // One text row plus the border. Without a height, a top-anchored box
      // stretched to the bottom of the screen after a layout change (measured:
      // a full-height grey column after `/sidebar` hid the sidebar).
      height={3}
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
