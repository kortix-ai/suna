import { resolveShareLinkUrl } from '@/lib/share-link';

/**
 * Share links (`kortix.com/share/*`) have no in-app route. The root layout's
 * link handler opens them in the in-app browser, so the router must not
 * navigate: a warm link keeps the current screen, a cold start begins at the
 * splash screen.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (resolveShareLinkUrl(path)) return initial ? '/' : null;
  } catch {
    // Never throw here: an error in this hook can crash the app.
  }
  return path;
}
