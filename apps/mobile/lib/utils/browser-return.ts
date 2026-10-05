/**
 * Waits for the user to come back from the in-app browser.
 *
 * `WebBrowser.openBrowserAsync` resolves when the browser CLOSES on iOS, but
 * on Android it resolves `{ type: 'opened' }` the moment the Custom Tab
 * launches (expo-web-browser `WebBrowserModule.kt`). Work that must run after
 * the trip — a refetch, a "connected" toast — therefore also waits for the app
 * to leave the foreground and return to `active`. Pure (the AppState
 * subscription is injected) so `bun test` covers it; `open-browser.ts` wires
 * the real AppState.
 */
export type AppStateSubscribe = (listener: (state: string) => void) => { remove: () => void };

/** `cancel` removes the listener; the promise then never resolves. */
export function waitForForegroundReturn(subscribe: AppStateSubscribe): {
  returned: Promise<void>;
  cancel: () => void;
} {
  let cancel = () => {};
  const returned = new Promise<void>((resolve) => {
    let left = false;
    const subscription = subscribe((state) => {
      if (state !== 'active') {
        left = true;
        return;
      }
      if (!left) return;
      subscription.remove();
      resolve();
    });
    cancel = () => subscription.remove();
  });
  return { returned, cancel };
}
