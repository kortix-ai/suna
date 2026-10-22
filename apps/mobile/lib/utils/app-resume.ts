/**
 * Deferred work for the app's return to the foreground. About 12 `AppState`
 * handlers fire on that tick (stream, auth refresh, probes). Work that can
 * wait (warm session, push registration, the OTA check) starts after them.
 */
import { AppState } from 'react-native';

/**
 * Runs `callback` `delayMs` after the app returns to the foreground. Leaving
 * the foreground first cancels the run. Returns the unsubscribe function.
 */
export function addResumeListener(callback: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const subscription = AppState.addEventListener('change', (state) => {
    cancel();
    if (state !== 'active') return;
    timer = setTimeout(() => {
      timer = null;
      callback();
    }, delayMs);
  });
  return () => {
    cancel();
    subscription.remove();
  };
}
