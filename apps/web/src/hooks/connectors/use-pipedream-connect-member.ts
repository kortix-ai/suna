'use client';

import { createFrontendClient } from '@pipedream/sdk/browser';
import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast } from '@/components/ui/toast';
import {
  pipedreamConnectConnectionProfile,
  pipedreamFinalizeConnectionProfile,
  reconcileMemberConnectionProfile,
} from '@kortix/sdk/projects-client';

const PIPEDREAM_IFRAME_SELECTOR = 'iframe[id^="pipedream-connect-iframe-"]';

/**
 * Keep the Pipedream connect iframe interactive when it renders over a Radix
 * dialog/modal that would otherwise trap pointer-events, focus, or Escape.
 * Returns a cleanup function to call once the connect flow settles.
 */
export function withPipedreamOverlayEscape(): () => void {
  if (typeof document === 'undefined') return () => {};

  const releasePointerEvents = () => {
    document.querySelectorAll<HTMLIFrameElement>(PIPEDREAM_IFRAME_SELECTOR).forEach((el) => {
      el.style.pointerEvents = 'auto';
    });
  };
  const observer = new MutationObserver(releasePointerEvents);
  observer.observe(document.body, { childList: true });
  releasePointerEvents();

  const isPipedreamFrame = (node: EventTarget | null): boolean =>
    node instanceof Element && node.matches(PIPEDREAM_IFRAME_SELECTOR);

  const guardFocus = (event: FocusEvent) => {
    if (isPipedreamFrame(event.target) || isPipedreamFrame(event.relatedTarget)) {
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener('focusin', guardFocus, true);
  document.addEventListener('focusout', guardFocus, true);

  const guardEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (document.querySelector(PIPEDREAM_IFRAME_SELECTOR)) event.stopImmediatePropagation();
  };
  document.addEventListener('keydown', guardEscape, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', guardFocus, true);
    document.removeEventListener('focusout', guardFocus, true);
    document.removeEventListener('keydown', guardEscape, true);
  };
}

/**
 * Connect the CURRENT USER's own private (member-owned) account for a Pipedream
 * connector: mint a member profile, run the Pipedream OAuth handshake, then
 * finalize. The result is usable ONLY in this user's own private sessions and is
 * never shared with the team. Shared by the connectors view and the
 * connect-to-start gate so both drive one implementation.
 */
export function usePipedreamConnectMember(projectId: string, slug: string, onConnected: () => void) {
  return useMutation({
    mutationFn: async () => {
      const profile = await reconcileMemberConnectionProfile(projectId, {
        connector_alias: slug,
        label: 'Private connection',
      });
      const { token, app } = await pipedreamConnectConnectionProfile(projectId, profile.profile_id);
      if (!token || !app) throw new Error('App connect is not configured');
      const pd = createFrontendClient({
        externalUserId: `${projectId}:${slug}:${profile.profile_id}`,
        tokenCallback: async () => ({ token, connect_link_url: undefined, expires_at: '' }) as any,
      });
      const release = withPipedreamOverlayEscape();
      let connected = false;
      try {
        connected = await new Promise<boolean>((resolve, reject) => {
          pd.connectAccount({
            app,
            token,
            onSuccess: () => resolve(true),
            onClose: (status: { successful: boolean }) => resolve(status.successful),
            onError: (err: unknown) =>
              reject(new Error((err as Error)?.message || 'Connection cancelled')),
          });
        });
      } finally {
        release();
      }
      if (!connected) return { connected: false };
      await pipedreamFinalizeConnectionProfile(projectId, profile.profile_id);
      return { connected: true };
    },
    onSuccess: (res) => {
      if (!res.connected) return;
      successToast('Connected privately — only you can use this');
      onConnected();
    },
    onError: (err: Error) => errorToast(err.message),
  });
}
