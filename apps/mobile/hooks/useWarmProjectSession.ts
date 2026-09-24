/**
 * Keep one warm session ready while the user is present on a project: the
 * project screen is mounted and the app is in the foreground (web's
 * `useWarmProjectSession`, with `AppState` for tab visibility).
 *
 * Ensures on mount and whenever the app returns to the foreground. On return
 * it first re-reads the held session: another device may have used it.
 * `enabled` is the project's `warm_sessions` flag (a warm sandbox is billed
 * compute); the server enforces it too, this only avoids the call.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { warmSessionPool } from '@/lib/session/warm-session-pool';

/** Is the user looking at the app right now? */
export function appIsActive(): boolean {
  return AppState.currentState === 'active';
}

export function useWarmProjectSession(projectId: string | null | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!projectId || !enabled) return;
    if (appIsActive()) void warmSessionPool.ensure(projectId);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void warmSessionPool.revalidate(projectId).then(() => {
        if (appIsActive()) void warmSessionPool.ensure(projectId);
      });
    });
    return () => subscription.remove();
  }, [projectId, enabled]);
}
