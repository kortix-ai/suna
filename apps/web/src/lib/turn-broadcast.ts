'use client';

/**
 * Cross-tab bridge for finished turns.
 *
 * The live session-event stream (SDK `useRuntimeEventStream`) is mounted by the
 * session page alone — any other tab (project page, dashboard, a different
 * session) has no way to hear that a turn finished, so the completion toast,
 * sound and favicon badge never reached the customer watching from another
 * tab. The tab that owns the stream publishes the completion here; every other
 * Kortix tab receives it and runs the same notification path.
 *
 * BroadcastChannel delivers only to OTHER contexts in the same origin, so the
 * publishing tab never receives its own event — exactly the "other tabs" scope
 * of the feature. Tabs without support (or SSR) get a no-op.
 */

export interface TurnCompleteMsg {
  sessionId: string;
  sessionTitle?: string;
  /** Project the session belongs to, captured on the publishing tab's URL —
   *  a receiving tab may be on a page where the project is not in the path. */
  projectId?: string | null;
  /** That project's `notification_center` flag in the publishing tab's cache.
   *  A receiving tab often never loaded the project. Absent: no answer. */
  notificationCenter?: boolean;
  at: number;
}

const CHANNEL_NAME = 'kortix-turn-complete';

/** One channel per tab: the spec delivers a post to every same-name instance
 *  EXCEPT the posting one, so a shared instance is what keeps a tab from
 *  hearing its own broadcast (its subscriber would otherwise count as a
 *  different instance and double-notify locally). */
let channel: BroadcastChannel | null = null;

function bus(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    channel ??= new BroadcastChannel(CHANNEL_NAME);
  } catch {
    // Some embedded browsers reject the constructor; the bridge is
    // best-effort, the local notification still works.
    return null;
  }
  return channel;
}

/** Test seam: drop the cached channel so a test process can simulate several
 *  tabs, each with its own instance. Not part of the app surface. */
export function resetTurnBroadcastForTests(): void {
  channel = null;
}

export function broadcastTurnComplete(msg: Omit<TurnCompleteMsg, 'at'>): void {
  try {
    bus()?.postMessage({ ...msg, at: Date.now() });
  } catch {
    // Best-effort: a failed broadcast must not break the local notification.
  }
}

export function onTurnComplete(handler: (msg: TurnCompleteMsg) => void): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (event: MessageEvent<TurnCompleteMsg>) => {
    if (event.data?.sessionId) handler(event.data);
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

/**
 * Receive-side policy for a completion arriving from another tab.
 *
 * Skips a session this tab is already viewing (its own stream — or the
 * broadcast — already handled it, and a toast for the turn on screen is
 * noise) and folds duplicates: several open session pages of the same
 * sandbox each see the completion event and each publish, so a receiving
 * tab can be hit more than once within the fold window. The window only has
 * to absorb cross-tab publish jitter (milliseconds), not real turns — a
 * second genuine completion of the same session minutes later must still
 * announce.
 */
export function createTurnCompleteGate(
  isViewing: (sessionId: string) => boolean,
  notify: (msg: TurnCompleteMsg) => void,
  foldWindowMs = 3_000,
): (msg: TurnCompleteMsg) => void {
  const handled = new Map<string, number>();
  return (msg) => {
    if (isViewing(msg.sessionId)) return;
    const last = handled.get(msg.sessionId);
    if (last !== undefined && msg.at - last < foldWindowMs) return;
    handled.set(msg.sessionId, msg.at);
    notify(msg);
  };
}
