/**
 * The app's one way to open an external web link (COR-151). `linkTarget`
 * (`./link-target.ts`, tested) decides: a Kortix link opens in the in-app
 * browser, a third-party link in the system browser. Anything that is not an
 * http(s) URL goes to `Linking.openURL` unchanged.
 *
 * Not for OAuth / checkout round trips that wait for an app-scheme redirect —
 * those keep `WebBrowser.openAuthSessionAsync` — and not for tel:/mailto:.
 *
 * Rejects when the link cannot open; callers decide whether to report it.
 */
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { linkTarget } from './link-target';

export async function openLink(url: string): Promise<void> {
  const trimmed = url.trim();
  if (linkTarget(trimmed) === 'in-app') {
    await WebBrowser.openBrowserAsync(trimmed);
    return;
  }
  await Linking.openURL(trimmed);
}
