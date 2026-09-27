import { resolveShareLinkUrl } from '@/lib/share-link';
import { isBrowserReturnPath } from '@/lib/session/connect-model';

/**
 * Share links (`kortix.com/share/*`) have no in-app route. The root layout's
 * link handler opens them in the in-app browser, so the router must not
 * navigate: a warm link keeps the current screen, a cold start begins at the
 * splash screen.
 *
 * In-app browser return URLs (`kortix://providers/…`, `kortix://connectors/…`)
 * only close the browser session. On Android they also arrive as a deep link;
 * the same rule keeps the user on the screen that opened the browser.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (resolveShareLinkUrl(path) || isBrowserReturnPath(path)) return initial ? '/' : null;
  } catch {
    // Never throw here: an error in this hook can crash the app.
  }
  return path;
}
