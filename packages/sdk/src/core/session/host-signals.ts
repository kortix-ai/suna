/**
 * Lifecycle signals from a host that has no DOM events.
 *
 * A browser tells the SDK that the tab is visible again or the network is back
 * through `visibilitychange` and `online`. React Native has neither event: its
 * host reports the same facts here, from `AppState` and its network listener.
 * `retry` is a person asking for a reconnect now (a "Reconnect" control).
 *
 * No globals, so the module loads on every runtime.
 */
export type HostSignal = 'visible' | 'online' | 'retry';

const listeners = new Set<(signal: HostSignal) => void>();

/** Report a lifecycle signal to the SDK. Safe to call with no listener mounted. */
export function notifyHostSignal(signal: HostSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch {
      // One listener must not stop the others.
    }
  }
}

/** Run `listener` on every host signal. Returns the unsubscribe. */
export function onHostSignal(listener: (signal: HostSignal) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
