/**
 * Keep one warm session ready while the user is present on a project: the
 * project screen is mounted and the app is in the foreground (web's
 * `useWarmProjectSession`, with `AppState` for tab visibility).
 *
 * Ensures on mount and shortly after the app returns to the foreground. On
 * return it first re-reads the held session: another device may have used it.
 * `enabled` is the project's `warm_sessions` flag (a warm sandbox is billed
 * compute); the server enforces it too, this only avoids the call.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { warmSessionPool } from '@/lib/session/warm-session-pool';
import { addResumeListener } from '@/lib/utils/app-resume';

/** Is the user looking at the app right now? */
export function appIsActive(): boolean {
  return AppState.currentState === 'active';
}

/** Warm-session work on resume: a network read and maybe a sandbox start. */
const WARM_RESUME_DELAY_MS = 400;

export function useWarmProjectSession(projectId: string | null | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!projectId || !enabled) return;
    if (appIsActive()) void warmSessionPool.ensure(projectId);
    return addResumeListener(() => {
      void warmSessionPool.revalidate(projectId).then(() => {
        if (appIsActive()) void warmSessionPool.ensure(projectId);
      });
    }, WARM_RESUME_DELAY_MS);
  }, [projectId, enabled]);
}
