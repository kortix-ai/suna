/**
 * Opens a URL in the in-app browser and resolves once the user is back in
 * the app, on every platform (see `./browser-return.ts` for why Android needs
 * the AppState wait). For hand-offs that act after the trip: connect a model
 * provider, connect a connector. Rejects when the browser cannot open.
 */
import { AppState } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { waitForForegroundReturn } from './browser-return';

export async function openBrowserUntilClosed(url: string): Promise<void> {
  // Subscribe before launching: the Custom Tab backgrounds the app right away.
  const { returned, cancel } = waitForForegroundReturn((listener) =>
    AppState.addEventListener('change', listener),
  );
  let result: WebBrowser.WebBrowserResult;
  try {
    result = await WebBrowser.openBrowserAsync(url);
  } catch (error) {
    cancel();
    throw error;
  }
  // iOS resolves on close: the trip is already over.
  if (result.type !== 'opened') {
    cancel();
    return;
  }
  await returned;
}
