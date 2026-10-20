'use client';

/**
 * A Kortix App inside the session browser (KRTX-2441): which project App a URL
 * belongs to, the signed-in frame URL for it, and its name for the chrome.
 *
 * A raw App link in chat carries no access token, so an `access: members` App
 * would frame its sign-in gate. The browser mints the App's access session and
 * moves its one-shot token onto the clicked URL, which keeps the deep path; the
 * App redeems it with a 303 to the same path and a host-only cookie.
 */

import { isKortixAppUrl } from '../apps/kortix-app-url';
import { APP_ACCESS_PARAM, withoutAppAccessToken } from '../internal/lib/utils/app-access-token';
import type { App } from '@kortix/sdk';
import { useAppAccess, useProjectApps } from '@kortix/sdk/react';
import { useRef } from 'react';

import { appCan } from '../apps/app-shared';

export { withoutAppAccessToken };


function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The project App that serves `url`: its own host or one of its services' hosts. */
export function appForUrl(apps: readonly App[] | undefined, url: string): App | null {
  if (!apps?.length || !isKortixAppUrl(url)) return null;
  const host = hostOf(url);
  if (!host) return null;
  return (
    apps.find((app) =>
      [app.url, ...(app.services ?? []).map((service) => service.url)].some((candidate) => hostOf(candidate) === host),
    ) ?? null
  );
}

/** `url` carrying the one-shot token from an access-session URL. */
export function withAppAccessToken(url: string, sessionUrl: string): string {
  try {
    const token = new URL(sessionUrl).searchParams.get(APP_ACCESS_PARAM);
    if (!token) return url;
    const target = new URL(url);
    target.searchParams.set(APP_ACCESS_PARAM, token);
    return target.toString();
  } catch {
    return url;
  }
}

/**
 * The session browser's view of `url`. `src` is what the iframe loads: `url`
 * itself for anything that is not a project App, the token-carrying URL for an
 * App the viewer may open, and null while that is still being resolved.
 *
 * `src` is pinned per `url`. The access-session query refetches on focus, and
 * a new token must not reload a frame the user has navigated inside.
 */
export function useAppInBrowser(projectId: string | undefined, url: string | null) {
  const apps = useProjectApps(projectId);
  const app = url ? appForUrl(apps.data, url) : null;
  const needsSession =
    !!app && !url!.includes(`${APP_ACCESS_PARAM}=`) && app.viewer_can_access !== false && appCan(app, 'preview');
  const access = useAppAccess(projectId, app?.app_id, { policy: false, session: needsSession });

  let resolved: string | null = url;
  if (url && projectId && isKortixAppUrl(url)) {
    if (apps.isLoading) resolved = null;
    else if (needsSession) {
      if (access.session.data) resolved = withAppAccessToken(url, access.session.data.url);
      else if (!access.session.isError) resolved = null;
    }
  }

  const pinned = useRef<{ url: string; src: string } | null>(null);
  if (url && resolved && pinned.current?.url !== url) pinned.current = { url, src: resolved };
  const src = url && pinned.current?.url === url ? pinned.current.src : resolved;

  return { app, apps: apps.data ?? [], src };
}
