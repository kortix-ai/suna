'use client';

import { useEffect } from 'react';

import { useAuth } from '@/features/providers/auth-provider';

import { KORTIX_EXTENSION_ID } from './extension';

export interface ExtensionIdentityMessage {
  type: 'kortix.identity';
  userId: string;
  email: string;
}

/**
 * True when this document is the Kortix browser extension's side panel: framed,
 * and the framing page is the extension. Referrer is the only signal a page
 * gets about its embedder, and it is a hint, not a credential. The extension
 * checks `event.origin` on its side and trusts nothing else.
 */
export function isInsideExtensionPanel(referrer: string, framed: boolean): boolean {
  return framed && referrer.startsWith(`chrome-extension://${KORTIX_EXTENSION_ID}`);
}

export function identityMessage(user: { id: string; email?: string | null }): ExtensionIdentityMessage {
  return { type: 'kortix.identity', userId: user.id, email: user.email ?? '' };
}

/**
 * Tells the extension which account this app is signed in to, so the panel can
 * warn when it differs from the account the extension is connected as.
 * Renders nothing. One instance, in the authenticated app shell.
 */
export function ExtensionPanelIdentity() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user || !isInsideExtensionPanel(document.referrer, window.top !== window.self)) return;
    // '*': the embedder origin is not readable here. The payload is the user's
    // own id and email, shown to the page that already frames this app.
    window.parent.postMessage(identityMessage(user), '*');
  }, [user]);
  return null;
}
