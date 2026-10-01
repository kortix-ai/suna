/**
 * Run something when the tab comes back to the foreground.
 *
 * A backgrounded tab is throttled, not paused and not told: browsers clamp its
 * timers (Chrome to roughly one tick a minute), so the transcript liveness
 * poll — 10s while a session is working — effectively stops, and the SSE
 * connection can be dropped without a visible error. Return is therefore the
 * moment the tab is LEAST sure it has the runtime's messages, and the only
 * moment it can find out cheaply.
 *
 * Framework-free and injectable so the rule is testable without a DOM.
 */
import { onHostSignal } from '../../core/session/host-signals';

export interface VisibilityTarget {
  visibilityState: string;
  addEventListener: (type: 'visibilitychange', handler: () => void) => void;
  removeEventListener: (type: 'visibilitychange', handler: () => void) => void;
}

export function onTabVisible(
  run: () => void,
  target: VisibilityTarget | undefined = typeof document === 'undefined'
    ? undefined
    : (document as unknown as VisibilityTarget),
): () => void {
  // A host without a document (React Native) reports the return itself.
  const stopHost = onHostSignal((signal) => {
    if (signal === 'visible') run();
  });
  if (!target) return stopHost;
  const handler = () => {
    // Only the transition INTO visible. `visibilitychange` fires on the way out
    // too, and reading a tail the moment a tab is hidden repairs nothing.
    if (target.visibilityState !== 'visible') return;
    run();
  };
  target.addEventListener('visibilitychange', handler);
  return () => {
    stopHost();
    target.removeEventListener('visibilitychange', handler);
  };
}
