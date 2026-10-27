/**
 * The app's one way to open an external web link. Every http(s) URL opens in
 * the in-app browser (`linkTarget`, `./link-target.ts`, tested; KRTX-2104).
 * Anything else (tel:, mailto:, an app scheme) goes to `Linking.openURL`.
 *
 * Not for OAuth / checkout round trips that wait for an app-scheme redirect —
 * those keep `WebBrowser.openAuthSessionAsync`.
 *
 * Rejects when the link cannot open; callers decide whether to report it.
 */
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { isSafeExternalLink } from '@/lib/markdown/safe-link';
import { IN_APP_BROWSER_OPTIONS, linkTarget } from './link-target';

/**
 * Opens a link from message markdown when its scheme is http(s) or mailto.
 * Any other scheme is ignored, and a failed open never becomes an unhandled
 * rejection.
 */
export function openExternalLink(href: unknown) {
  if (!isSafeExternalLink(href)) return;
  openLink(href).catch(() => {});
}

export async function openLink(url: string): Promise<void> {
  const trimmed = url.trim();
  if (linkTarget(trimmed) === 'in-app') {
    await WebBrowser.openBrowserAsync(trimmed, IN_APP_BROWSER_OPTIONS);
    return;
  }
  await Linking.openURL(trimmed);
}
