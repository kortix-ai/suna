'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { useAuth } from '@/features/providers/auth-provider';

import { EXTENSION_ORIGIN, isExtensionPanelFrame } from '@/lib/supabase/panel-cookies';

import { postPanelRoute } from './panel/panel-channel';

export interface ExtensionIdentityMessage {
  type: 'kortix.identity';
  userId: string;
  email: string;
}

/**
 * True when this document is the Kortix in Chrome side panel: framed, and the
 * framing page is the extension. `ancestorOrigins` is exact; the referrer is
 * the fallback where a browser has no `ancestorOrigins`, and it is a hint, not
 * a credential. The extension checks `event.origin` on its side.
 */
export function isInsideExtensionPanel(
  referrer: string,
  framed: boolean,
  ancestorOrigins?: ArrayLike<string>,
): boolean {
  return isExtensionPanelFrame(ancestorOrigins, referrer, framed);
}

export function identityMessage(user: { id: string; email?: string | null }): ExtensionIdentityMessage {
  return { type: 'kortix.identity', userId: user.id, email: user.email ?? '' };
}

const insideThisPanel = () =>
  isInsideExtensionPanel(document.referrer, window.top !== window.self, window.location.ancestorOrigins);

/**
 * Tells the extension which account this app is signed in to, so the panel can
 * warn when it differs from the account the extension is connected as, and
 * which page the panel shows, so an Act send's tab reaches the session it
 * opens. Renders nothing. One instance, in the authenticated app shell.
 */
export function ExtensionPanelIdentity() {
  const { user } = useAuth();
  const pathname = usePathname();
  useEffect(() => {
    if (!user || !insideThisPanel()) return;
    // The target origin is the extension: no other page frames the panel.
    window.parent.postMessage(identityMessage(user), EXTENSION_ORIGIN);
  }, [user]);
  useEffect(() => {
    if (pathname && insideThisPanel()) postPanelRoute(pathname);
  }, [pathname]);
  return null;
}
