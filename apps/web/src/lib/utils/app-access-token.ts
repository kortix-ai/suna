/**
 * A Kortix App's one-shot access token rides the URL as `?__kortix_access=`.
 * It is a credential (5 min, redeemed for a host-only cookie), so no persisted
 * store may keep it: the tab store, browser recents. The session browser mints
 * a fresh one whenever it frames an App (`useAppInBrowser`).
 */
export const APP_ACCESS_PARAM = '__kortix_access';

/** `url` without an access token: the form that is safe to persist or share. */
export function withoutAppAccessToken(url: string): string {
  if (!url.includes(`${APP_ACCESS_PARAM}=`)) return url;
  try {
    const target = new URL(url);
    target.searchParams.delete(APP_ACCESS_PARAM);
    return target.toString();
  } catch {
    return '';
  }
}
