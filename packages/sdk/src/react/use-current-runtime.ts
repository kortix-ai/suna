'use client';

import { useSyncExternalStore } from 'react';

import { type CurrentRuntimeState, currentRuntimeStore } from '../core/session/current-runtime';

/**
 * React selector hook over the framework-free `currentRuntimeStore`. Keep
 * selectors primitive-valued (string/number/null) — the selected value is
 * compared by reference on every store change.
 */
export function useCurrentRuntime<T>(selector: (state: CurrentRuntimeState) => T): T {
  return useSyncExternalStore(
    currentRuntimeStore.subscribe,
    () => selector(currentRuntimeStore.getState()),
    () => selector(currentRuntimeStore.getState()),
  );
}
